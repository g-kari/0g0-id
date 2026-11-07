/** Shared policy finalization after a trusted authentication result.
 * No provider exchange or passkey verification happens here. A caller must first
 * authenticate and load the current user, including ban/verification checks.
 */
import type { Context } from "hono";
import type { IdpEnv, OAuthStateCookieData, TokenPayload, User } from "@0g0-id/shared";
import {
  findResourceServerByUri,
  tryBootstrapAdmin,
  generateToken,
  sha256,
  createAuthCode,
  insertLoginEvent,
  createLogger,
  isAccountLocked,
  resetFailedAttempts,
  restErrorBody,
  getClientIp,
} from "@0g0-id/shared";
import { isAllowedRedirectTo, validateServiceFinalRedirect } from "../../utils/auth-helpers";
import { isSubjectAllowedForResource } from "../../utils/scopes";

export type LoginFinalizationState = Pick<
  OAuthStateCookieData,
  | "bffState"
  | "redirectTo"
  | "serviceId"
  | "nonce"
  | "codeChallenge"
  | "codeChallengeMethod"
  | "scope"
  | "resource"
> & {
  /** Historical auth_codes method label, not OAuth provider configuration. */ provider?: string;
  /** Optional pre-authentication resource generation binding for native login. */
  expectedResourceServerId?: string;
};
type FinalizationContext = Context<{ Bindings: IdpEnv; Variables: { user: TokenPayload } }>;
const authLogger = createLogger("auth");

export async function validateFinalRedirect(
  c: FinalizationContext,
  stateData: LoginFinalizationState,
): Promise<boolean> {
  return stateData.serviceId
    ? validateServiceFinalRedirect(c.env.DB, stateData.serviceId, stateData.redirectTo)
    : isAllowedRedirectTo(stateData.redirectTo, c.env.IDP_ORIGIN, c.env.EXTRA_BFF_ORIGINS);
}

/**
 * RFC 6749 §4.1.2.1 形式で、検証済みの redirect 先へエラーを返す。
 * 呼び出し側で validateFinalRedirect を通過していることが前提。
 */
export function redirectWithOAuthError(
  c: FinalizationContext,
  stateData: LoginFinalizationState,
  error: string,
  description: string,
): Response {
  const errorUrl = new URL(stateData.redirectTo);
  errorUrl.searchParams.set("error", error);
  errorUrl.searchParams.set("error_description", description);
  errorUrl.searchParams.set("state", stateData.bffState);
  return c.redirect(errorUrl.toString());
}

export async function finalizeLogin(
  c: FinalizationContext,
  user: User,
  provider: string,
  stateData: LoginFinalizationState,
): Promise<Response> {
  const lockoutStatus = await isAccountLocked(c.env.DB, user.id);
  if (lockoutStatus.locked) {
    authLogger.warn("[oauth-callback] Account locked out", {
      userId: user.id,
      lockedUntil: lockoutStatus.lockedUntil,
      failedAttempts: lockoutStatus.failedAttempts,
    });
    try {
      await insertLoginEvent(c.env.DB, {
        userId: user.id,
        provider,
        ipAddress: getClientIp(c.req.raw),
        userAgent: c.req.header("user-agent")?.slice(0, 512) ?? null,
        country: c.req.header("cf-ipcountry") ?? null,
        success: false,
      });
    } catch {
      // ログ記録失敗はフローに影響させない
    }
    return c.json(
      {
        error: {
          ...restErrorBody(
            "ACCOUNT_LOCKED",
            "Too many failed login attempts. Please try again later.",
          ).error,
          locked_until: lockoutStatus.lockedUntil,
        },
      },
      429,
    );
  }

  if (
    c.env.BOOTSTRAP_ADMIN_EMAIL &&
    user.email_verified === 1 &&
    user.email.toLowerCase() === c.env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase() &&
    user.role !== "admin"
  ) {
    try {
      const elevated = await tryBootstrapAdmin(c.env.DB, user.id);
      if (elevated) user.role = "admin";
    } catch (err) {
      authLogger.error("[bootstrap] Failed to elevate bootstrap admin", err);
      return c.json(
        restErrorBody("INTERNAL_ERROR", "Failed to elevate bootstrap admin. Please try again."),
        500,
      );
    }
  }

  try {
    await insertLoginEvent(c.env.DB, {
      userId: user.id,
      provider,
      ipAddress: getClientIp(c.req.raw),
      userAgent: c.req.header("user-agent")?.slice(0, 512) ?? null,
      country: c.req.header("cf-ipcountry") ?? null,
      success: true,
    });
    if (lockoutStatus.failedAttempts > 0) {
      await resetFailedAttempts(c.env.DB, user.id);
    }
  } catch (err) {
    authLogger.error("[login-event] Failed to record login event", err);
  }

  // 最終リダイレクト先の検証はフローで分ける:
  // - service 付きフロー: その service に登録された redirect URI との一致で確認する
  //   （BFF 向け許可リストでは DCR で受理した外部 callback が弾かれてしまうため）
  // - BFF フロー: 従来どおり同一登録可能ドメイン / EXTRA_BFF_ORIGINS で確認する
  // 検証を先に行うことで、後段のエラーも検証済みの宛先へ返せるようにする。
  const redirectAllowed = await validateFinalRedirect(c, stateData);
  if (!redirectAllowed) {
    authLogger.error("[callback] Redirect URL failed final check", {
      redirectTo: stateData.redirectTo,
      serviceId: stateData.serviceId ?? null,
    });
    return c.json(restErrorBody("BAD_REQUEST", "Invalid redirect URL"), 400);
  }

  // RFC 8707: resource 付きフローでは、認可コードを発行する段階でも
  // リソースの現行登録と利用者制限（allowed_subjects）を照合する。
  // 認可エンドポイント時点ではユーザーが確定しないため、この最終段が
  // 認可段階の実施点になる（トークン発行・更新でも再照合する）。
  // 宛先は検証済みのため、失敗は 400 で止めずクライアントへエラーを返す
  // （RFC 6749 §4.1.2.1）。resource は service フローでのみ設定される。
  // 認可コードへ固定する登録世代（resource 付きフローのみ）。
  // 検証した resource_servers 行の id をコードに保存し、交換時に現在の
  // 行と照合することで、削除→同 URI 再登録を経たコードを無効化する。
  let resourceServerId: string | null = null;
  if (stateData.resource) {
    const resourceServer = await findResourceServerByUri(c.env.DB, stateData.resource);
    if (
      !resourceServer ||
      (stateData.expectedResourceServerId !== undefined &&
        resourceServer.id !== stateData.expectedResourceServerId)
    ) {
      authLogger.error("[callback] Resource is no longer registered", {
        resource: stateData.resource,
      });
      return redirectWithOAuthError(
        c,
        stateData,
        "invalid_target",
        "Resource is no longer registered",
      );
    }
    if (!isSubjectAllowedForResource(resourceServer, user.id)) {
      authLogger.warn("[callback] Subject not allowed for resource", {
        resource: stateData.resource,
        userId: user.id,
      });
      return redirectWithOAuthError(
        c,
        stateData,
        "access_denied",
        "You are not allowed to use this resource",
      );
    }
    resourceServerId = resourceServer.id;
  }

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
      resource: stateData.resource ?? null,
      resourceServerId,
    });
  } catch (err) {
    authLogger.error("[callback] Failed to create authorization code", err);
    return c.json(restErrorBody("INTERNAL_ERROR", "Failed to create authorization code"), 500);
  }

  const callbackUrl = new URL(stateData.redirectTo);
  callbackUrl.searchParams.set("code", authCode);
  callbackUrl.searchParams.set("state", stateData.bffState);

  return c.redirect(callbackUrl.toString());
}
