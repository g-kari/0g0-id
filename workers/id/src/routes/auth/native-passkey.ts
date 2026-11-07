import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { IdpEnv, TokenPayload } from "@0g0-id/shared";
import {
  generateToken,
  generateCodeChallenge,
  sha256,
  timingSafeEqual,
  getClientIp,
  findUserById,
  isAccountLocked,
} from "@0g0-id/shared";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { passkeyRelyingParty } from "../../../../../packages/shared/src/db/passkey-challenges";
import { createDiscoverablePasskeyFlow } from "../../utils/discoverable-passkey";
import { openNativeCookie, sealNativeCookie } from "../../utils/native-login-cookie";
import {
  readNativeContinuation,
  nativeContinuationIsCurrent,
  type NativeContinuation,
} from "./native-passkey-state";
import { nativePasskeyPage } from "./native-passkey-page";
import { finalizeLogin } from "./finalize";
import { BodyTooLarge, boundedBody } from "../../utils/auth-http-body";

export type NativePasskeyEnv = IdpEnv & { PASSKEY_LOGIN_ENABLED?: string };
type Env = { Bindings: NativePasskeyEnv; Variables: { user: TokenPayload } };
type NativeContext = Context<Env>;
const BROWSER_COOKIE = "__Host-idp-native-browser";
const FLOW_COOKIE = "__Host-idp-native-login";
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/" };

interface Flow {
  browserHash: string;
  transaction: string;
  csrf: string;
  exp: number;
  continuation: NativeContinuation;
  challengeId?: string;
  requiredCredential?: { credentialHash: string; registrationId: string };
}

function failure(c: NativeContext, status: 400 | 403 | 404 | 413 | 429 | 503 = 400) {
  return c.json(
    { error: { code: "LOGIN_UNAVAILABLE", message: "Unable to continue login" } },
    status,
  );
}

async function flowContext(c: NativeContext): Promise<{ flow: Flow; binding: string } | null> {
  const browser = await openNativeCookie(
    getCookie(c, BROWSER_COOKIE),
    c.env.COOKIE_SECRET,
    "browser",
    c.env.IDP_ORIGIN,
  );
  const raw = await openNativeCookie(
    getCookie(c, FLOW_COOKIE),
    c.env.COOKIE_SECRET,
    "continuation",
    c.env.IDP_ORIGIN,
  );
  if (
    !browser ||
    typeof browser.value !== "string" ||
    !SECRET_RE.test(browser.value) ||
    !raw ||
    typeof raw.browserHash !== "string" ||
    !timingSafeEqual(raw.browserHash, await sha256(browser.value)) ||
    typeof raw.transaction !== "string" ||
    !SECRET_RE.test(raw.transaction) ||
    typeof raw.csrf !== "string" ||
    !SECRET_RE.test(raw.csrf) ||
    typeof raw.continuation !== "object" ||
    raw.continuation === null ||
    Array.isArray(raw.continuation) ||
    (raw.challengeId !== undefined &&
      (typeof raw.challengeId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(raw.challengeId)))
  )
    return null;
  // Only this server creates this AEAD purpose. Still validate fields before use.
  const continuation = raw.continuation as Partial<NativeContinuation>;
  const state = continuation.finalization;
  if (
    !state ||
    typeof state !== "object" ||
    state.provider !== "passkey" ||
    typeof state.redirectTo !== "string" ||
    typeof state.bffState !== "string"
  )
    return null;
  const flow = raw as unknown as Flow;
  // A valid assertion for a different continuation in the SAME browser must not
  // authorize this client/redirect. Bind challenges to the random transaction too.
  const binding = await generateCodeChallenge(`${browser.value}.${flow.transaction}`);
  return { flow, binding };
}

async function writeFlow(c: NativeContext, flow: Flow) {
  setCookie(
    c,
    FLOW_COOKIE,
    await sealNativeCookie(
      { ...flow },
      c.env.COOKIE_SECRET,
      "continuation",
      c.env.IDP_ORIGIN,
      flow.exp,
    ),
    { ...COOKIE_OPTIONS, maxAge: Math.max(0, flow.exp - Math.floor(Date.now() / 1000)) },
  );
}

const app = new Hono<Env>();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  if (c.env.PASSKEY_LOGIN_ENABLED !== "true") return failure(c, 404);
  try {
    const rp = passkeyRelyingParty(c.env.IDP_ORIGIN);
    if (
      rp.origin !== c.env.IDP_ORIGIN ||
      new URL(c.req.url).origin !== rp.origin ||
      typeof c.env.COOKIE_SECRET !== "string" ||
      c.env.COOKIE_SECRET.length < 32 ||
      !c.env.DB ||
      !c.env.RATE_LIMITER_AUTH
    )
      return failure(c, 503);
    if (c.req.method === "POST") {
      if (
        c.req.header("Origin") !== rp.origin ||
        (c.req.header("Sec-Fetch-Site") !== undefined &&
          c.req.header("Sec-Fetch-Site") !== "same-origin")
      )
        return failure(c, 403);
      if (c.req.header("Content-Encoding") && c.req.header("Content-Encoding") !== "identity")
        return failure(c);
    }
    if (
      !(
        await c.env.RATE_LIMITER_AUTH.limit({
          key: `native:${getClientIp(c.req.raw) ?? "unknown"}`,
        })
      ).success
    )
      return failure(c, 429);
    await next();
  } catch {
    return failure(c, 503);
  }
});

// GET validates the continuation and installs cookies. It never consumes email
// proof, creates a credential/user, sends mail, or calls navigator.credentials.
/** Internal handoff only. It installs a fresh login ceremony, never an auth code.
 * A signup receipt may constrain a new signature; possession of it is not proof. */
export async function beginNativeLogin(
  c: NativeContext,
  continuation: NativeContinuation,
  requiredCredential?: { credentialId: string; registrationId: string },
): Promise<Response> {
  if (
    c.env.PASSKEY_LOGIN_ENABLED !== "true" ||
    !(await nativeContinuationIsCurrent(c.env, continuation))
  )
    return failure(c);
  const browser = generateToken(32);
  const exp = Math.floor(Date.now() / 1000) + 600;
  const browserCookie = await sealNativeCookie(
    { value: browser },
    c.env.COOKIE_SECRET,
    "browser",
    c.env.IDP_ORIGIN,
    exp,
  );
  const flow: Flow = {
    browserHash: await sha256(browser),
    transaction: generateToken(32),
    csrf: generateToken(32),
    exp,
    continuation,
    ...(requiredCredential
      ? {
          requiredCredential: {
            credentialHash: await sha256(requiredCredential.credentialId),
            registrationId: requiredCredential.registrationId,
          },
        }
      : {}),
  };
  // Serialize both before setting either, including the aggregate cookie bound.
  await writeFlow(c, flow);
  setCookie(c, BROWSER_COOKIE, browserCookie, { ...COOKIE_OPTIONS, maxAge: 600 });
  return c.redirect("/auth/passkey", 303);
}

app.get("/start", async (c) => {
  const continuation = await readNativeContinuation(new URL(c.req.url), c.env);
  if (!continuation) return failure(c);
  return beginNativeLogin(c, continuation);
});

app.get("/", async (c) => {
  const context = await flowContext(c);
  if (!context) return failure(c);
  const callbackOrigin = new URL(context.flow.continuation.finalization.redirectTo).origin;
  // Include only the verified callback origin: Chromium also applies form-action
  // to redirects after POST. Never interpolate an unchecked URL into CSP.
  if (!/^[a-z]+:\/\/[a-z0-9.[\]:-]+$/.test(callbackOrigin)) return failure(c);
  const nonce = generateToken(16);
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'`,
  );
  c.header(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=(), payment=(), usb=(), bluetooth=(), magnetometer=(), gyroscope=(), accelerometer=(), ambient-light-sensor=(), display-capture=(), screen-wake-lock=(), publickey-credentials-get=(self), publickey-credentials-create=()",
  );
  return c.html(
    nativePasskeyPage(context.flow.csrf, nonce, context.flow.requiredCredential !== undefined),
  );
});

app.post("/options", async (c) => {
  const context = await flowContext(c);
  if (!context) return failure(c, 403);
  if (c.req.header("Content-Type")?.split(";", 1)[0].trim() !== "application/json")
    return failure(c);
  let body: unknown;
  try {
    body = JSON.parse(await boundedBody(c.req.raw));
  } catch (error) {
    return failure(c, error instanceof BodyTooLarge ? 413 : 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return failure(c);
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    input.confirm !== true ||
    typeof input.csrf !== "string" ||
    !SECRET_RE.test(input.csrf) ||
    !timingSafeEqual(input.csrf, context.flow.csrf)
  )
    return failure(c, 403);
  if (!(await nativeContinuationIsCurrent(c.env, context.flow.continuation))) return failure(c);
  const issued = await createDiscoverablePasskeyFlow(c.env.DB, c.env.IDP_ORIGIN).options(
    context.binding,
  );
  if (!issued) return failure(c);
  await writeFlow(c, { ...context.flow, challengeId: issued.challengeId });
  return c.json({ options: issued.options }); // No owner, email, binding, authority or receipt.
});

app.post("/verify", async (c) => {
  const context = await flowContext(c);
  if (!context?.flow.challengeId) return failure(c, 403);
  if (c.req.header("Content-Type")?.split(";", 1)[0].trim() !== "application/x-www-form-urlencoded")
    return failure(c);
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await boundedBody(c.req.raw));
  } catch (error) {
    return failure(c, error instanceof BodyTooLarge ? 413 : 400);
  }
  const csrf = params.get("csrf");
  if (
    params.size !== 2 ||
    params.getAll("csrf").length !== 1 ||
    params.getAll("credential").length !== 1 ||
    !csrf ||
    !SECRET_RE.test(csrf) ||
    !timingSafeEqual(csrf, context.flow.csrf)
  )
    return failure(c, 403);
  let response: AuthenticationResponseJSON;
  try {
    response = JSON.parse(params.get("credential")!) as AuthenticationResponseJSON;
  } catch {
    return failure(c);
  }
  const result = await createDiscoverablePasskeyFlow(c.env.DB, c.env.IDP_ORIGIN).authenticate({
    browserBinding: context.binding,
    challengeId: context.flow.challengeId,
    response,
  });
  if (!result.verified) return failure(c);
  const required = context.flow.requiredCredential;
  if (
    required &&
    (required.credentialHash !== (await sha256(result.credentialId)) ||
      required.registrationId !== result.registrationId)
  )
    return failure(c);
  // The assertion is consumed. There is no automatic retry after this boundary.
  deleteCookie(c, FLOW_COOKIE, COOKIE_OPTIONS);
  deleteCookie(c, BROWSER_COOKIE, COOKIE_OPTIONS);
  const user = await findUserById(c.env.DB, result.userId);
  if (
    !user ||
    user.email_verified !== 1 ||
    user.banned_at !== null ||
    (await isAccountLocked(c.env.DB, user.id)).locked ||
    !(await nativeContinuationIsCurrent(c.env, context.flow.continuation))
  )
    return failure(c);
  // Shared finalizer rechecks lockout, redirect registration and current resource
  // subjects, preserving normal code/state/nonce/PKCE/scope/token exchange rules.
  return finalizeLogin(c, user, "passkey", context.flow.continuation.finalization);
});

app.onError((_error, c) => failure(c, 503));

export default app;
