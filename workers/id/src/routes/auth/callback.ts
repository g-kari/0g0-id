import type { Context } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import type { IdpEnv, OAuthStateCookieData, TokenPayload, User } from "@0g0-id/shared";
import {
  timingSafeEqual,
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
  restErrorBody,
  verifyCookie,
} from "@0g0-id/shared";
import { type OAuthProvider, PROVIDER_DISPLAY_NAMES, isValidProvider } from "@0g0-id/shared";
import { getClientIp } from "../../utils/ip";
import { type ProviderResolution, resolveProvider } from "../../utils/provider-resolution";
import {
  CALLBACK_PATH,
  OAUTH_ERROR_MAP,
  STATE_COOKIE,
  PKCE_COOKIE,
  parseStateFromCookie,
  handleProviderLink,
  validateProviderCredentials,
  isAllowedRedirectTo,
} from "../../utils/auth-helpers";

const authLogger = createLogger("auth");

type CallbackContext = Context<{ Bindings: IdpEnv; Variables: Variables }>;
type Variables = { user: TokenPayload };

type CallbackResult<T> = ({ ok: true } & T) | { ok: false; response: Response };

function clearOAuthCookies(c: CallbackContext): void {
  deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
  deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });
}

async function handleOAuthError(c: CallbackContext, error: string): Promise<Response> {
  const stateCookieRaw = getCookie(c, STATE_COOKIE);
  clearOAuthCookies(c);

  if (stateCookieRaw) {
    const stateData = await parseStateFromCookie(stateCookieRaw, c.env.COOKIE_SECRET);
    if (
      stateData &&
      isAllowedRedirectTo(stateData.redirectTo, c.env.IDP_ORIGIN, c.env.EXTRA_BFF_ORIGINS)
    ) {
      const safeErrorCode = error in OAUTH_ERROR_MAP ? error : "access_denied";
      const errorUrl = new URL(stateData.redirectTo);
      errorUrl.searchParams.set("error", safeErrorCode);
      errorUrl.searchParams.set("state", stateData.bffState);
      return c.redirect(errorUrl.toString());
    }
  }

  const safeMessage =
    OAUTH_ERROR_MAP[error as keyof typeof OAUTH_ERROR_MAP] ?? "Authentication failed";
  return c.json(restErrorBody("OAUTH_ERROR", safeMessage), 400);
}

async function validateCallbackState(
  c: CallbackContext,
  state: string,
): Promise<CallbackResult<{ stateData: OAuthStateCookieData; pkceVerifier: string }>> {
  const stateCookieRaw = getCookie(c, STATE_COOKIE);
  const pkceCookieRaw = getCookie(c, PKCE_COOKIE);

  if (!stateCookieRaw || !pkceCookieRaw) {
    return {
      ok: false,
      response: c.json(restErrorBody("BAD_REQUEST", "Missing session cookies"), 400),
    };
  }

  const pkceVerifier = await verifyCookie(pkceCookieRaw, c.env.COOKIE_SECRET);
  if (!pkceVerifier) {
    authLogger.error("[oauth-callback] PKCE cookie verification failed");
    clearOAuthCookies(c);
    return {
      ok: false,
      response: c.json(restErrorBody("BAD_REQUEST", "Invalid PKCE cookie"), 400),
    };
  }

  const stateData = await parseStateFromCookie(stateCookieRaw, c.env.COOKIE_SECRET);
  if (!stateData) {
    authLogger.error("[oauth-callback] State cookie verification or parse failed");
    clearOAuthCookies(c);
    return {
      ok: false,
      response: c.json(restErrorBody("BAD_REQUEST", "Invalid state cookie"), 400),
    };
  }

  if (!timingSafeEqual(state, stateData.idState)) {
    clearOAuthCookies(c);
    return {
      ok: false,
      response: c.json(restErrorBody("BAD_REQUEST", "State mismatch"), 400),
    };
  }

  clearOAuthCookies(c);
  return { ok: true, stateData, pkceVerifier };
}

function validateProviderConfig(
  c: CallbackContext,
  stateData: OAuthStateCookieData,
): CallbackResult<{ provider: OAuthProvider }> {
  if (!stateData.provider) {
    return {
      ok: false,
      response: c.json(restErrorBody("BAD_REQUEST", "Missing provider in state"), 400),
    };
  }
  const provider: OAuthProvider = stateData.provider;
  if (!isValidProvider(provider)) {
    return {
      ok: false,
      response: c.json(restErrorBody("BAD_REQUEST", "Invalid provider in state"), 400),
    };
  }
  const credResult = validateProviderCredentials(provider, c.env);
  if (!credResult.ok) {
    return {
      ok: false,
      response: c.json(restErrorBody(credResult.code, credResult.message), 400),
    };
  }
  return { ok: true, provider };
}

async function resolveUserAccount(
  c: CallbackContext,
  provider: OAuthProvider,
  resolved: Extract<ProviderResolution, { ok: true }>,
  stateData: OAuthStateCookieData,
): Promise<CallbackResult<{ user: User }>> {
  const userId = crypto.randomUUID();
  let user: User;

  if (stateData.linkUserId) {
    const linkTargetUser = await findUserById(c.env.DB, stateData.linkUserId);
    if (!linkTargetUser || linkTargetUser.banned_at !== null) {
      if (linkTargetUser) {
        await recordFailedAttempt(c.env.DB, linkTargetUser.id).catch(() => {});
      }
      return {
        ok: false,
        response: c.json(restErrorBody("ACCOUNT_BANNED", "Your account has been suspended"), 403),
      };
    }
    const result = await handleProviderLink(c.env.DB, stateData.linkUserId, provider, resolved.sub);
    if (!result.ok) {
      return {
        ok: false,
        response: c.json(
          restErrorBody(
            "PROVIDER_ALREADY_LINKED",
            `This ${PROVIDER_DISPLAY_NAMES[provider]} account is already linked to another user`,
          ),
          409,
        ),
      };
    }
    user = result.user;
  } else {
    user = await resolved.upsert(c.env.DB, userId);
  }

  if (user.banned_at !== null) {
    return {
      ok: false,
      response: c.json(restErrorBody("ACCOUNT_BANNED", "Your account has been suspended"), 403),
    };
  }

  return { ok: true, user };
}

async function finalizeLogin(
  c: CallbackContext,
  user: User,
  provider: OAuthProvider,
  stateData: OAuthStateCookieData,
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
    return c.json(restErrorBody("INTERNAL_ERROR", "Failed to create authorization code"), 500);
  }

  if (!isAllowedRedirectTo(stateData.redirectTo, c.env.IDP_ORIGIN, c.env.EXTRA_BFF_ORIGINS)) {
    authLogger.error("[callback] Redirect URL failed allowlist check", {
      redirectTo: stateData.redirectTo,
    });
    return c.json(restErrorBody("BAD_REQUEST", "Invalid redirect URL"), 400);
  }

  const callbackUrl = new URL(stateData.redirectTo);
  callbackUrl.searchParams.set("code", authCode);
  callbackUrl.searchParams.set("state", stateData.bffState);

  return c.redirect(callbackUrl.toString());
}

/**
 * GET /auth/callback — OAuthコールバック（全プロバイダー共通）
 */

export async function handleCallback(c: CallbackContext) {
  const error = c.req.query("error");
  if (error) return handleOAuthError(c, error);

  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    clearOAuthCookies(c);
    return c.json(restErrorBody("BAD_REQUEST", "Missing code or state"), 400);
  }

  const stateResult = await validateCallbackState(c, state);
  if (!stateResult.ok) return stateResult.response;
  const { stateData, pkceVerifier } = stateResult;

  const providerResult = validateProviderConfig(c, stateData);
  if (!providerResult.ok) return providerResult.response;
  const { provider } = providerResult;

  const callbackUri = `${c.env.IDP_ORIGIN}${CALLBACK_PATH}`;
  const resolved = await resolveProvider(c, provider, code, pkceVerifier, callbackUri);
  if (!resolved.ok) return resolved.response;

  const userResult = await resolveUserAccount(c, provider, resolved, stateData);
  if (!userResult.ok) return userResult.response;

  return finalizeLogin(c, userResult.user, provider, stateData);
}
