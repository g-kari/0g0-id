import type { Context } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import type { IdpEnv, OAuthStateCookieData, TokenPayload } from "@0g0-id/shared";
import {
  timingSafeEqual,
  verifyCookie,
  findUserById,
  tryBootstrapAdmin,
  generateToken,
  sha256,
  createAuthCode,
  insertLoginEvent,
  createLogger,
  isAccountLocked,
  recordFailedAttempt,
  resetFailedAttempts,
} from "@0g0-id/shared";
import {
  type OAuthProvider,
  PROVIDER_DISPLAY_NAMES,
  isValidProvider,
  PROVIDER_CREDENTIALS,
} from "@0g0-id/shared";
import { getClientIp } from "../../utils/ip";
import { resolveProvider } from "../../utils/provider-resolution";
import {
  CALLBACK_PATH,
  OAUTH_ERROR_MAP,
  STATE_COOKIE,
  PKCE_COOKIE,
  parseStateFromCookie,
  handleProviderLink,
} from "../../utils/auth-helpers";

const authLogger = createLogger("auth");

/**
 * GET /auth/callback — OAuthコールバック（全プロバイダー共通）
 */
type Variables = { user: TokenPayload };

export async function handleCallback(c: Context<{ Bindings: IdpEnv; Variables: Variables }>) {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    // RFC 6749 §4.1.2.1: プロバイダーエラーはBFFコールバックURLへリダイレクト転送
    const stateCookieRaw = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
    deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });

    if (stateCookieRaw) {
      const stateData = await parseStateFromCookie(stateCookieRaw, c.env.COOKIE_SECRET);
      if (stateData) {
        const safeErrorCode = error in OAUTH_ERROR_MAP ? error : "access_denied";
        const errorUrl = new URL(stateData.redirectTo);
        errorUrl.searchParams.set("error", safeErrorCode);
        errorUrl.searchParams.set("state", stateData.bffState);
        return c.redirect(errorUrl.toString());
      }
    }

    const safeMessage =
      OAUTH_ERROR_MAP[error as keyof typeof OAUTH_ERROR_MAP] ?? "Authentication failed";
    return c.json({ error: { code: "OAUTH_ERROR", message: safeMessage } }, 400);
  }

  if (!code || !state) {
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
    deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing code or state" } }, 400);
  }

  // Cookie検証
  const stateCookieRaw = getCookie(c, STATE_COOKIE);
  const pkceVerifier = getCookie(c, PKCE_COOKIE);

  if (!stateCookieRaw || !pkceVerifier) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing session cookies" } }, 400);
  }

  let stateData: OAuthStateCookieData;

  // HMAC-SHA256署名を検証してからpayloadをパースする（Cookie改ざん検知）
  const verifiedPayload = await verifyCookie(stateCookieRaw, c.env.COOKIE_SECRET);
  if (!verifiedPayload) {
    authLogger.error("[oauth-callback] State cookie signature verification failed");
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
    deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid state cookie" } }, 400);
  }

  try {
    stateData = JSON.parse(verifiedPayload);
  } catch (err) {
    authLogger.error("[oauth-callback] Failed to parse state cookie", err);
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
    deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid state cookie" } }, 400);
  }

  // state検証（タイミング攻撃対策のため定数時間比較を使用）
  if (!timingSafeEqual(state, stateData.idState)) {
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
    deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });
    return c.json({ error: { code: "BAD_REQUEST", message: "State mismatch" } }, 400);
  }

  // Cookie削除（__Host- prefix には secure: true が必須）
  deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
  deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });

  const callbackUri = `${c.env.IDP_ORIGIN}${CALLBACK_PATH}`;

  // providerの検証（Cookie改ざん対策）
  if (!stateData.provider) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing provider in state" } }, 400);
  }
  const provider: OAuthProvider = stateData.provider;
  if (!isValidProvider(provider)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid provider in state" } }, 400);
  }

  // Google以外はオプション設定のため資格情報の存在を確認
  if (provider !== "google") {
    const creds = PROVIDER_CREDENTIALS[provider];
    if (!c.env[creds.id] || !c.env[creds.secret]) {
      return c.json(
        {
          error: {
            code: "PROVIDER_NOT_CONFIGURED",
            message: `${creds.name} provider is not configured`,
          },
        },
        400,
      );
    }
  }

  // プロバイダー固有の認証処理（コード交換・ユーザー情報取得）
  const resolved = await resolveProvider(c, provider, code, pkceVerifier, callbackUri);
  if (!resolved.ok) return resolved.response;

  // アカウント連携またはユーザー作成/更新
  const userId = crypto.randomUUID();
  let user;
  if (stateData.linkUserId) {
    // BAN済みユーザーへのプロバイダー連携を防止（DBに書き込む前にチェック）
    const linkTargetUser = await findUserById(c.env.DB, stateData.linkUserId);
    if (!linkTargetUser || linkTargetUser.banned_at !== null) {
      if (linkTargetUser) {
        await recordFailedAttempt(c.env.DB, linkTargetUser.id).catch(() => {});
      }
      return c.json(
        { error: { code: "ACCOUNT_BANNED", message: "Your account has been suspended" } },
        403,
      );
    }
    const result = await handleProviderLink(c.env.DB, stateData.linkUserId, provider, resolved.sub);
    if (!result.ok) {
      return c.json(
        {
          error: {
            code: "PROVIDER_ALREADY_LINKED",
            message: `This ${PROVIDER_DISPLAY_NAMES[provider]} account is already linked to another user`,
          },
        },
        409,
      );
    }
    user = result.user;
  } else {
    user = await resolved.upsert(c.env.DB, userId);
  }

  // BANされたユーザーのログインを拒否
  if (user.banned_at !== null) {
    return c.json(
      { error: { code: "ACCOUNT_BANNED", message: "Your account has been suspended" } },
      403,
    );
  }

  // アカウントロックアウトチェック
  const lockoutStatus = await isAccountLocked(c.env.DB, user.id);
  if (lockoutStatus.locked) {
    authLogger.warn("[oauth-callback] Account locked out", {
      userId: user.id,
      lockedUntil: lockoutStatus.lockedUntil,
      failedAttempts: lockoutStatus.failedAttempts,
    });
    try {
      const ipAddress = getClientIp(c.req.raw);
      const userAgent = c.req.header("user-agent")?.slice(0, 512) ?? null;
      const country = c.req.header("cf-ipcountry") ?? null;
      await insertLoginEvent(c.env.DB, {
        userId: user.id,
        provider,
        ipAddress,
        userAgent,
        country,
        success: false,
      });
    } catch {
      // ログ記録失敗はフローに影響させない
    }
    return c.json(
      {
        error: {
          code: "ACCOUNT_LOCKED",
          message: "Too many failed login attempts. Please try again later.",
          locked_until: lockoutStatus.lockedUntil,
        },
      },
      429,
    );
  }

  // 管理者ブートストラップ（管理者が0人の場合のみ・原子的操作）
  if (
    c.env.BOOTSTRAP_ADMIN_EMAIL &&
    user.email.toLowerCase() === c.env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase() &&
    user.role !== "admin"
  ) {
    try {
      const elevated = await tryBootstrapAdmin(c.env.DB, user.id);
      if (elevated) user.role = "admin";
    } catch (err) {
      authLogger.error("[bootstrap] Failed to elevate bootstrap admin", err);
      return c.json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "Failed to elevate bootstrap admin. Please try again.",
          },
        },
        500,
      );
    }
  }

  // ログインイベント記録 + ロックアウトカウンターリセット（エラーがあってもログインフローは継続）
  try {
    const ipAddress = getClientIp(c.req.raw);
    const userAgent = c.req.header("user-agent")?.slice(0, 512) ?? null;
    const country = c.req.header("cf-ipcountry") ?? null;
    await insertLoginEvent(c.env.DB, {
      userId: user.id,
      provider,
      ipAddress,
      userAgent,
      country,
      success: true,
    });
    if (lockoutStatus.failedAttempts > 0) {
      await resetFailedAttempts(c.env.DB, user.id);
    }
  } catch (err) {
    authLogger.error("[login-event] Failed to record login event", err);
  }

  // ワンタイム認可コード発行
  const authCode = generateToken(32);
  const codeHash = await sha256(authCode);
  const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();

  try {
    await createAuthCode(c.env.DB, {
      id: crypto.randomUUID(),
      userId: user.id,
      serviceId: stateData.serviceId ?? null,
      codeHash,
      redirectTo: stateData.redirectTo,
      expiresAt,
      nonce: stateData.nonce ?? null,
      codeChallenge: stateData.codeChallenge ?? null,
      codeChallengeMethod: stateData.codeChallengeMethod ?? null,
      scope: stateData.scope ?? null,
      provider: stateData.provider,
    });
  } catch (err) {
    authLogger.error("[callback] Failed to create authorization code", err);
    return c.json(
      { error: { code: "SERVER_ERROR", message: "Failed to create authorization code" } },
      500,
    );
  }

  // BFFコールバックへリダイレクト
  const callbackUrl = new URL(stateData.redirectTo);
  callbackUrl.searchParams.set("code", authCode);
  callbackUrl.searchParams.set("state", stateData.bffState);

  return c.redirect(callbackUrl.toString());
}
