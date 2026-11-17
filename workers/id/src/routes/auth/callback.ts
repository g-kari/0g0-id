import { getCookie, deleteCookie } from "hono/cookie";
import type { OAuthStateCookieData } from "@0g0-id/shared";
import {
  timingSafeEqual,
  createLogger,
  restErrorBody,
  verifyCookie,
  type OAuthProvider,
  isValidProvider,
} from "@0g0-id/shared";
import {
  CALLBACK_PATH,
  OAUTH_ERROR_MAP,
  STATE_COOKIE,
  PKCE_COOKIE,
  parseStateFromCookie,
  validateProviderCredentials,
} from "../../utils/auth-helpers";
import { resolveProvider } from "../../utils/provider-resolution";
import { type CallbackContext, type CallbackResult, resolveUserAccount } from "./callback-account";
import { finalizeLogin, validateFinalRedirect, redirectWithOAuthError } from "./finalize";
import { handleSocialCallback } from "./social-callback";

const authLogger = createLogger("auth");

function clearOAuthCookies(c: CallbackContext): void {
  deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
  deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });
}

function badRequest(c: CallbackContext, message: string): CallbackResult<never> {
  return { ok: false, response: c.json(restErrorBody("BAD_REQUEST", message), 400) };
}

function jsonOAuthError(c: CallbackContext, error: string): Response {
  const safeMessage = OAUTH_ERROR_MAP[error] ?? "Authentication failed";
  return c.json(restErrorBody("OAUTH_ERROR", safeMessage), 400);
}

function redirectForOAuthError(
  c: CallbackContext,
  stateData: OAuthStateCookieData,
  error: string,
): Response {
  const safeErrorCode = error in OAUTH_ERROR_MAP ? error : "access_denied";
  return redirectWithOAuthError(
    c,
    stateData,
    safeErrorCode,
    OAUTH_ERROR_MAP[safeErrorCode] ?? "Authentication failed",
  );
}

async function handleOAuthError(c: CallbackContext, error: string): Promise<Response> {
  const stateCookieRaw = getCookie(c, STATE_COOKIE);
  clearOAuthCookies(c);
  if (!stateCookieRaw) return jsonOAuthError(c, error);

  const stateData = await parseStateFromCookie(stateCookieRaw, c.env.COOKIE_SECRET);
  if (!stateData || !(await validateFinalRedirect(c, stateData))) return jsonOAuthError(c, error);
  return redirectForOAuthError(c, stateData, error);
}

async function readOAuthSession(
  c: CallbackContext,
): Promise<CallbackResult<{ stateData: OAuthStateCookieData; pkceVerifier: string }>> {
  const stateCookieRaw = getCookie(c, STATE_COOKIE);
  const pkceCookieRaw = getCookie(c, PKCE_COOKIE);
  if (!stateCookieRaw || !pkceCookieRaw) return badRequest(c, "Missing session cookies");

  const pkceVerifier = await verifyCookie(pkceCookieRaw, c.env.COOKIE_SECRET);
  if (!pkceVerifier) {
    authLogger.error("[oauth-callback] PKCE cookie verification failed");
    clearOAuthCookies(c);
    return badRequest(c, "Invalid PKCE cookie");
  }

  const stateData = await parseStateFromCookie(stateCookieRaw, c.env.COOKIE_SECRET);
  if (!stateData) {
    authLogger.error("[oauth-callback] State cookie verification or parse failed");
    clearOAuthCookies(c);
    return badRequest(c, "Invalid state cookie");
  }
  return { ok: true, stateData, pkceVerifier };
}

async function validateCallbackState(
  c: CallbackContext,
  state: string,
): Promise<CallbackResult<{ stateData: OAuthStateCookieData; pkceVerifier: string }>> {
  const session = await readOAuthSession(c);
  if (!session.ok) return session;
  if (!timingSafeEqual(state, session.stateData.idState)) {
    clearOAuthCookies(c);
    return badRequest(c, "State mismatch");
  }
  clearOAuthCookies(c);
  return session;
}

function validateProviderConfig(
  c: CallbackContext,
  stateData: OAuthStateCookieData,
): CallbackResult<{ provider: OAuthProvider }> {
  if (!stateData.provider) return badRequest(c, "Missing provider in state");
  const provider: OAuthProvider = stateData.provider;
  if (!isValidProvider(provider)) return badRequest(c, "Invalid provider in state");
  const credResult = validateProviderCredentials(provider, c.env);
  if (!credResult.ok) {
    return {
      ok: false,
      response: c.json(restErrorBody(credResult.code, credResult.message), 400),
    };
  }
  return { ok: true, provider };
}

async function optInSocialResponse(c: CallbackContext): Promise<Response | undefined> {
  const signedState = getCookie(c, STATE_COOKIE);
  if (!signedState) return undefined;
  const initialState = await parseStateFromCookie(signedState, c.env.COOKIE_SECRET);
  if (initialState?.provider !== "discord" && initialState?.provider !== "steam") return undefined;
  return handleSocialCallback(c, "discord");
}

function readAuthorizationCode(
  c: CallbackContext,
): CallbackResult<{ code: string; state: string }> {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (code && state) return { ok: true, code, state };
  clearOAuthCookies(c);
  return badRequest(c, "Missing code or state");
}

async function completeAuthorizationCodeLogin(
  c: CallbackContext,
  code: string,
  state: string,
): Promise<Response> {
  const stateResult = await validateCallbackState(c, state);
  if (!stateResult.ok) return stateResult.response;
  const { stateData, pkceVerifier } = stateResult;

  const providerResult = validateProviderConfig(c, stateData);
  if (!providerResult.ok) return providerResult.response;
  const { provider } = providerResult;

  const resolved = await resolveProvider(
    c,
    provider,
    code,
    pkceVerifier,
    `${c.env.IDP_ORIGIN}${CALLBACK_PATH}`,
  );
  if (!resolved.ok) return resolved.response;

  const userResult = await resolveUserAccount(c, provider, resolved, stateData);
  if (!userResult.ok) return userResult.response;
  return finalizeLogin(c, userResult.user, provider, stateData);
}

/**
 * GET /auth/callback — OAuthコールバック（全プロバイダー共通）
 */
export async function handleCallback(c: CallbackContext) {
  const social = await optInSocialResponse(c);
  if (social) return social;

  const error = c.req.query("error");
  if (error) return handleOAuthError(c, error);

  const authorization = readAuthorizationCode(c);
  if (!authorization.ok) return authorization.response;
  return completeAuthorizationCodeLogin(c, authorization.code, authorization.state);
}
