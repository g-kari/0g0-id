import type { Context } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import {
  consumeSocialLoginTransaction,
  consumeSteamLoginNonce,
  socialLoginSchemaReady,
  verifyCookie,
  timingSafeEqual,
  verifySteamAssertion,
  upsertSocialLoginUser,
  restErrorBody,
} from "@0g0-id/shared";
import type { IdpEnv, TokenPayload, OAuthStateCookieData } from "@0g0-id/shared";
import {
  STATE_COOKIE,
  PKCE_COOKIE,
  CALLBACK_PATH,
  STEAM_CALLBACK_PATH,
  validateProviderCredentials,
} from "../../utils/auth-helpers";
import { resolveProvider, type ProviderResolution } from "../../utils/provider-resolution";
import { resolveUserAccount } from "./callback-account";
import { finalizeLogin, validateFinalRedirect, redirectWithOAuthError } from "./finalize";

type CallbackContext = Context<{ Bindings: IdpEnv; Variables: { user: TokenPayload } }>;

/** Separate strict callback path for opt-in providers; never fall back to legacy validation. */
export async function handleSocialCallback(c: CallbackContext, provider: "discord" | "steam") {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const stateCookie = getCookie(c, STATE_COOKIE);
  const bindingCookie = getCookie(c, PKCE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
  deleteCookie(c, PKCE_COOKIE, { path: "/", secure: true });
  const fail = () =>
    c.json(restErrorBody("OAUTH_ERROR", "Authentication failed; restart login"), 400);
  if (!validateProviderCredentials(provider, c.env).ok) return fail();
  if (!stateCookie || !bindingCookie) return fail();
  const statePayload = await verifyCookie(stateCookie, c.env.COOKIE_SECRET);
  const browserBinding = await verifyCookie(bindingCookie, c.env.COOKIE_SECRET);
  if (!statePayload || !browserBinding) return fail();
  let stateData: OAuthStateCookieData;
  try {
    stateData = JSON.parse(statePayload) as OAuthStateCookieData;
  } catch {
    return fail();
  }
  const url = new URL(c.req.url);
  const callbackPath = provider === "discord" ? CALLBACK_PATH : STEAM_CALLBACK_PATH;
  const queryState = url.searchParams.get("state");
  if (
    !stateData ||
    stateData.provider !== provider ||
    typeof stateData.idState !== "string" ||
    !queryState ||
    url.searchParams.getAll("state").length !== 1 ||
    !timingSafeEqual(queryState, stateData.idState) ||
    url.origin !== c.env.IDP_ORIGIN ||
    url.pathname !== callbackPath ||
    url.hash ||
    !(await socialLoginSchemaReady(c.env.DB))
  )
    return fail();
  try {
    if (
      !(await consumeSocialLoginTransaction(c.env.DB, {
        state: queryState,
        browserBinding,
        statePayload,
        provider,
        idpOrigin: c.env.IDP_ORIGIN,
      }))
    )
      return fail();
  } catch {
    return fail();
  }
  // The claim is single-use even when a provider denies access or its network call fails.
  let resolved: ProviderResolution;
  if (provider === "discord") {
    const allowed = new Set(["state", "code", "iss", "error", "error_description", "error_uri"]);
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return fail();
    }
    if (url.searchParams.get("iss") !== "https://discord.com") return fail();
    if (url.searchParams.has("error")) {
      if (url.searchParams.has("code")) return fail();
      if (!(await validateFinalRedirect(c, stateData))) return fail();
      return redirectWithOAuthError(
        c,
        stateData,
        "access_denied",
        "Authentication was not completed",
      );
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 2048) return fail();
    resolved = await resolveProvider(
      c,
      provider,
      code,
      browserBinding,
      `${c.env.IDP_ORIGIN}${CALLBACK_PATH}`,
    );
  } else {
    try {
      const { steamId } = await verifySteamAssertion({
        callbackUrl: c.req.url,
        expectedReturnTo: `${c.env.IDP_ORIGIN}${STEAM_CALLBACK_PATH}?state=${stateData.idState}`,
        consumeNonce: (hash, expiry) => consumeSteamLoginNonce(c.env.DB, hash, expiry),
      });
      resolved = {
        ok: true,
        sub: steamId,
        upsert: (db, id) =>
          upsertSocialLoginUser(db, {
            id,
            provider,
            sub: steamId,
            name: "Steam user",
            picture: null,
          }),
      };
    } catch {
      return fail();
    }
  }
  if (!resolved.ok) return resolved.response;
  try {
    const result = await resolveUserAccount(c, provider, resolved, stateData);
    if (!result.ok) return result.response;
    return finalizeLogin(c, result.user, provider, stateData);
  } catch {
    return fail();
  }
}
