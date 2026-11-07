import { Hono } from "hono";
import type { IdpEnv, TokenPayload } from "@0g0-id/shared";
import { generateToken, getClientIp, timingSafeEqual } from "@0g0-id/shared";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import {
  createEmailSignupIntent,
  deliverEmailSignupIntent,
  verifyEmailSignupIntent,
  findVerifiedEmailSignupIntent,
} from "../../../../../packages/shared/src/db/email-signup-intents";
import { passkeyRelyingParty } from "../../../../../packages/shared/src/db/passkey-challenges";
import { VERIFICATION_EMAIL_SENDER, sendVerificationEmail } from "../../utils/verification-email";
import { createPasskeyFlow } from "../../utils/passkey-flow";
import { boundedBody, BodyTooLarge } from "../../utils/auth-http-body";
import {
  type EmailContext,
  type SignupState,
  readSignupState,
  installSignupState,
  readEnrollmentState,
  installEnrollmentState,
  clearSignupState,
  validSignupName,
} from "../../utils/email-passkey-state";
import { readNativeContinuation, nativeContinuationIsCurrent } from "./native-passkey-state";
import { beginNativeLogin } from "./native-passkey";
import { emailPasskeyPage, type EmailPageMode } from "./email-passkey-page";

const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const app = new Hono<{ Bindings: IdpEnv; Variables: { user: TokenPayload } }>();

function page(
  c: EmailContext,
  mode: EmailPageMode,
  csrf: string,
  status: 200 | 400 | 404 | 503 = 200,
) {
  const nonce = generateToken(16);
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
  c.header(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=(), payment=(), usb=(), bluetooth=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
  );
  return c.html(emailPasskeyPage(mode, csrf, nonce), status);
}
function failure(c: EmailContext, status: 400 | 403 | 404 | 413 | 429 | 503 = 400) {
  // Even an expired/disabled/missing-cookie email landing clears its fragment.
  if ((c.req.method === "GET" || c.req.method === "HEAD") && c.req.path.endsWith("/verify"))
    return page(c, "verify", "", status === 404 ? 404 : status === 503 ? 503 : 400);
  return c.json(
    { error: { code: "SIGNUP_UNAVAILABLE", message: "Unable to continue signup" } },
    status,
  );
}
function accepted(c: EmailContext) {
  return c.json(
    { status: "accepted", message: "If eligible, follow the email in this browser" },
    202,
  );
}

export function emailSignupConfiguration(env: IdpEnv): { dailyLimit: number } | null {
  const limit = env.EMAIL_SIGNUP_DAILY_LIMIT;
  if (
    env.EMAIL_PASSKEY_SIGNUP_ENABLED !== "true" ||
    env.VERIFICATION_EMAIL_ENABLED !== "true" ||
    env.PASSKEY_LOGIN_ENABLED !== "true" ||
    env.VERIFICATION_EMAIL_FROM !== VERIFICATION_EMAIL_SENDER ||
    typeof env.VERIFICATION_EMAIL?.send !== "function" ||
    !env.RATE_LIMITER_EMAIL_SIGNUP ||
    !env.RATE_LIMITER_EMAIL_SIGNUP_GLOBAL ||
    !env.RATE_LIMITER_AUTH ||
    !env.DB ||
    typeof env.COOKIE_SECRET !== "string" ||
    env.COOKIE_SECRET.length < 32 ||
    typeof limit !== "string" ||
    !/^[1-9][0-9]*$/.test(limit) ||
    !Number.isSafeInteger(Number(limit)) ||
    Number(limit) > Math.floor(Number.MAX_SAFE_INTEGER / 31)
  )
    return null;
  try {
    if (passkeyRelyingParty(env.IDP_ORIGIN).origin !== env.IDP_ORIGIN) return null;
  } catch {
    return null;
  }
  return { dailyLimit: Number(limit) };
}

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  if (c.env.EMAIL_PASSKEY_SIGNUP_ENABLED !== "true") return failure(c, 404);
  if (!emailSignupConfiguration(c.env) || new URL(c.req.url).origin !== c.env.IDP_ORIGIN)
    return failure(c, 503);
  if (c.req.method === "POST") {
    if (
      c.req.header("Origin") !== c.env.IDP_ORIGIN ||
      (c.req.header("Sec-Fetch-Site") !== undefined &&
        c.req.header("Sec-Fetch-Site") !== "same-origin")
    )
      return failure(c, 403);
    if (c.req.header("Content-Encoding") && c.req.header("Content-Encoding") !== "identity")
      return failure(c);
  }
  const ipAllowed = (
    await c.env.RATE_LIMITER_EMAIL_SIGNUP!.limit({
      key: `email-signup:${getClientIp(c.req.raw) ?? "unknown"}`,
    })
  ).success;
  const mailRequest = c.req.method === "POST" && c.req.path.endsWith("/start");
  if (!ipAllowed) return mailRequest ? accepted(c) : failure(c, 429);
  if (
    mailRequest &&
    !(await c.env.RATE_LIMITER_EMAIL_SIGNUP_GLOBAL!.limit({ key: "email-signup-all" })).success
  )
    return accepted(c);
  await next();
});

async function input(
  c: EmailContext,
  fields: string[],
): Promise<Record<string, unknown> | Response> {
  if (c.req.header("Content-Type")?.split(";", 1)[0].trim() !== "application/json")
    return failure(c);
  try {
    const body: unknown = JSON.parse(await boundedBody(c.req.raw));
    if (!body || typeof body !== "object" || Array.isArray(body)) return failure(c);
    const data = body as Record<string, unknown>;
    if (
      Object.keys(data).length !== fields.length ||
      fields.some((key) => !Object.hasOwn(data, key))
    )
      return failure(c);
    return data;
  } catch (error) {
    return failure(c, error instanceof BodyTooLarge ? 413 : 400);
  }
}
function hasCsrf(data: Record<string, unknown>, state: SignupState) {
  return (
    typeof data.csrf === "string" &&
    SECRET_RE.test(data.csrf) &&
    timingSafeEqual(data.csrf, state.csrf) &&
    data.confirm === true
  );
}

app.get("/signup/start", async (c) => {
  const continuation = await readNativeContinuation(new URL(c.req.url), c.env);
  if (!continuation) return failure(c);
  await installSignupState(c, continuation);
  return c.redirect("/auth/email/signup", 303);
});
app.get("/signup", async (c) => {
  const context = await readSignupState(c);
  return context ? page(c, "signup", context.state.csrf) : failure(c);
});
app.get("/verify", async (c) => {
  const context = await readSignupState(c);
  return page(c, "verify", context?.state.csrf ?? ""); // No proof DB read/write.
});
app.get("/register", async (c) => {
  const context = await readSignupState(c);
  if (!context) return page(c, "recover", "", 400);
  const authority = await readEnrollmentState(c, context.state);
  const verified =
    authority &&
    (await findVerifiedEmailSignupIntent(c.env.DB, {
      ...authority,
      browserBinding: context.binding,
      idpOrigin: c.env.IDP_ORIGIN,
    }));
  return page(c, verified ? "register" : "recover", context.state.csrf);
});

app.post("/start", async (c) => {
  const context = await readSignupState(c);
  if (!context) return failure(c, 403);
  const data = await input(c, ["csrf", "confirm", "email"]);
  if (data instanceof Response) return data;
  if (!hasCsrf(data, context.state)) return failure(c, 403);
  if (!(await nativeContinuationIsCurrent(c.env, context.state.continuation))) return failure(c);
  // Resolve waitUntil before allocating any token. No synchronous provider wait
  // may expose existing-account/suppression through provider response latency.
  const execution = c.executionCtx;
  if (typeof execution.waitUntil !== "function") return failure(c, 503);
  if (typeof data.email !== "string" || data.email.length > 254) return accepted(c);
  try {
    const issued = await createEmailSignupIntent(c.env.DB, {
      browserBinding: context.binding,
      idpOrigin: c.env.IDP_ORIGIN,
      email: data.email.trim(),
      serverIntentId: context.state.intentId,
      dailyLimit: emailSignupConfiguration(c.env)!.dailyLimit,
    });
    if (issued) {
      // Token exists only in this in-memory delivery closure, never the response.
      execution.waitUntil(
        deliverEmailSignupIntent(
          c.env.DB,
          {
            ...issued,
            browserBinding: context.binding,
            idpOrigin: c.env.IDP_ORIGIN,
          },
          (message) =>
            sendVerificationEmail(
              {
                enabled: true,
                binding: c.env.VERIFICATION_EMAIL,
                sender: VERIFICATION_EMAIL_SENDER,
                idpOrigin: c.env.IDP_ORIGIN,
              },
              { ...message, expiresAt: Math.min(message.expiresAt, context.state.exp) },
            ),
        ),
      );
    }
  } catch {
    /* Lost/uncertain insert or scheduling must not regenerate or resend. */
  }
  return accepted(c); // Exactly the same status/body/cookie behavior for every outcome.
});

app.post("/verify", async (c) => {
  const context = await readSignupState(c);
  if (!context) return failure(c, 403);
  const data = await input(c, ["csrf", "confirm", "token"]);
  if (data instanceof Response) return data;
  if (
    !hasCsrf(data, context.state) ||
    typeof data.token !== "string" ||
    !SECRET_RE.test(data.token)
  )
    return failure(c, 403);
  if (!(await nativeContinuationIsCurrent(c.env, context.state.continuation))) return failure(c);
  const existing = await readEnrollmentState(c, context.state);
  if (
    existing &&
    (await findVerifiedEmailSignupIntent(c.env.DB, {
      ...existing,
      browserBinding: context.binding,
      idpOrigin: c.env.IDP_ORIGIN,
    }))
  )
    return c.json({ next: "/auth/email/register" });
  const verified = await verifyEmailSignupIntent(c.env.DB, {
    intentId: context.state.intentId,
    token: data.token,
    browserBinding: context.binding,
    idpOrigin: c.env.IDP_ORIGIN,
  });
  if (!verified) return failure(c);
  await installEnrollmentState(c, {
    intentId: verified.id,
    authority: verified.authority,
    exp: Math.min(context.state.exp, verified.expires_at),
    browserHash: context.state.browserHash,
    transaction: context.state.transaction,
  });
  return c.json({ next: "/auth/email/register" });
});

app.post("/registration/options", async (c) => {
  const context = await readSignupState(c);
  if (!context) return failure(c, 403);
  const data = await input(c, ["csrf", "confirm", "name"]);
  if (data instanceof Response) return data;
  if (!hasCsrf(data, context.state)) return failure(c, 403);
  if (!validSignupName(data.name)) return failure(c);
  const authority = await readEnrollmentState(c, context.state);
  if (!authority || !(await nativeContinuationIsCurrent(c.env, context.state.continuation)))
    return failure(c);
  const name = data.name.trim();
  const issued = await createPasskeyFlow(c.env.DB, c.env.IDP_ORIGIN).registrationOptions({
    ...authority,
    browserBinding: context.binding,
    userName: name,
  });
  if (!issued) return failure(c);
  await installEnrollmentState(c, { ...authority, pendingId: issued.pendingId, name });
  return c.json({ options: issued.options });
});

async function formInput(c: EmailContext, fields: string[]): Promise<URLSearchParams | Response> {
  if (c.req.header("Content-Type")?.split(";", 1)[0].trim() !== "application/x-www-form-urlencoded")
    return failure(c);
  try {
    const data = new URLSearchParams(await boundedBody(c.req.raw));
    if (data.size !== fields.length || fields.some((field) => data.getAll(field).length !== 1))
      return failure(c);
    return data;
  } catch (error) {
    return failure(c, error instanceof BodyTooLarge ? 413 : 400);
  }
}
app.post("/registration/complete", async (c) => {
  const context = await readSignupState(c);
  if (!context) return failure(c, 403);
  const data = await formInput(c, ["csrf", "credential"]);
  if (data instanceof Response) return data;
  const csrf = data.get("csrf")!;
  if (!SECRET_RE.test(csrf) || !timingSafeEqual(csrf, context.state.csrf)) return failure(c, 403);
  const authority = await readEnrollmentState(c, context.state);
  if (
    !authority?.pendingId ||
    !authority.name ||
    !(await nativeContinuationIsCurrent(c.env, context.state.continuation))
  )
    return page(c, "recover", context.state.csrf, 400);
  let response: RegistrationResponseJSON;
  try {
    response = JSON.parse(data.get("credential")!) as RegistrationResponseJSON;
  } catch {
    return page(c, "recover", context.state.csrf, 400);
  }
  const result = await createPasskeyFlow(c.env.DB, c.env.IDP_ORIGIN).completeRegistration({
    ...authority,
    pendingId: authority.pendingId,
    name: authority.name,
    browserBinding: context.binding,
    response,
  });
  if (result.status === "not_created") return page(c, "recover", context.state.csrf, 400);
  // Neither attestation-none nor a commit receipt is login proof. This installs
  // NEW native cookies; a NEW get challenge + NEW signature of this credential
  // generation is required before the existing finalizer can issue any code.
  clearSignupState(c);
  return beginNativeLogin(c, context.state.continuation, result.receipt);
});
app.post("/login", async (c) => {
  const context = await readSignupState(c);
  if (!context) return failure(c, 403);
  const data = await formInput(c, ["csrf", "confirm"]);
  if (data instanceof Response) return data;
  if (
    data.get("confirm") !== "true" ||
    !SECRET_RE.test(data.get("csrf")!) ||
    !timingSafeEqual(data.get("csrf")!, context.state.csrf)
  )
    return failure(c, 403);
  clearSignupState(c);
  return beginNativeLogin(c, context.state.continuation); // No email-only authentication.
});

app.onError((_error, c) => failure(c, 503));
export default app;
