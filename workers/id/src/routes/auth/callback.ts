import type { Context } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import type { IdpEnv, OAuthStateCookieData, TokenPayload, User } from "@0g0-id/shared";
import {
  timingSafeEqual,
  findUserById,
  createLogger,
  restErrorBody,
  verifyCookie,
} from "@0g0-id/shared";
import { type OAuthProvider, PROVIDER_DISPLAY_NAMES, isValidProvider } from "@0g0-id/shared";
import { type ProviderResolution, resolveProvider } from "../../utils/provider-resolution";
import {
  CALLBACK_PATH,
  OAUTH_ERROR_MAP,
  STATE_COOKIE,
  PKCE_COOKIE,
  parseStateFromCookie,
  handleProviderLink,
  validateProviderCredentials,
} from "../../utils/auth-helpers";
import { finalizeLogin, validateFinalRedirect, redirectWithOAuthError } from "./finalize";

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
    if (stateData && (await validateFinalRedirect(c, stateData))) {
      const safeErrorCode = error in OAUTH_ERROR_MAP ? error : "access_denied";
      return redirectWithOAuthError(
        c,
        stateData,
        safeErrorCode,
        OAUTH_ERROR_MAP[safeErrorCode] ?? "Authentication failed",
      );
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
    if (!linkTargetUser) {
      return {
        ok: false,
        response: c.json(restErrorBody("NOT_FOUND", "User not found"), 404),
      };
    }
    if (linkTargetUser.banned_at !== null) {
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
