import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { IdpEnv, TokenPayload } from "@0g0-id/shared";
import { generateToken, generateCodeChallenge, sha256, timingSafeEqual } from "@0g0-id/shared";
import { openNativeCookie, sealNativeCookie } from "./native-login-cookie";
import type { NativeContinuation } from "../routes/auth/native-passkey-state";

export type EmailContext = Context<{ Bindings: IdpEnv; Variables: { user: TokenPayload } }>;
export const SIGNUP_COOKIE = "__Host-idp-email-signup";
export const ENROLLMENT_COOKIE = "__Host-idp-email-enrollment";
const BROWSER_COOKIE = "__Host-idp-email-browser";
const OPTIONS = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/" };
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export interface SignupState {
  intentId: string;
  browserHash: string;
  transaction: string;
  csrf: string;
  exp: number;
  continuation: NativeContinuation;
}
export interface EnrollmentState {
  intentId: string;
  browserHash: string;
  transaction: string;
  authority: string;
  exp: number;
  name?: string;
  pendingId?: string;
}
export function validSignupName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 100 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

/** No DB operation. The random intent reservation exists identically even when
 * a later email request is suppressed. Never let a posted ID choose this value. */
export async function installSignupState(c: EmailContext, continuation: NativeContinuation) {
  const browser = generateToken(32);
  const exp = Math.floor(Date.now() / 1000) + 600;
  const state: SignupState = {
    intentId: crypto.randomUUID(),
    browserHash: await sha256(browser),
    transaction: generateToken(32),
    csrf: generateToken(32),
    exp,
    continuation,
  };
  const flowCookie = await sealNativeCookie(
    { ...state },
    c.env.COOKIE_SECRET,
    "email-signup",
    c.env.IDP_ORIGIN,
    exp,
  );
  const browserCookie = await sealNativeCookie(
    { value: browser },
    c.env.COOKIE_SECRET,
    "email-browser",
    c.env.IDP_ORIGIN,
    exp,
  );
  setCookie(c, SIGNUP_COOKIE, flowCookie, { ...OPTIONS, maxAge: 600 });
  setCookie(c, BROWSER_COOKIE, browserCookie, { ...OPTIONS, maxAge: 600 });
  deleteCookie(c, ENROLLMENT_COOKIE, OPTIONS);
}

export async function readSignupState(
  c: EmailContext,
): Promise<{ state: SignupState; binding: string } | null> {
  const browser = await openNativeCookie(
    getCookie(c, BROWSER_COOKIE),
    c.env.COOKIE_SECRET,
    "email-browser",
    c.env.IDP_ORIGIN,
  );
  const raw = await openNativeCookie(
    getCookie(c, SIGNUP_COOKIE),
    c.env.COOKIE_SECRET,
    "email-signup",
    c.env.IDP_ORIGIN,
  );
  if (
    !browser ||
    typeof browser.value !== "string" ||
    !SECRET.test(browser.value) ||
    !raw ||
    typeof raw.intentId !== "string" ||
    !UUID.test(raw.intentId) ||
    typeof raw.csrf !== "string" ||
    !SECRET.test(raw.csrf) ||
    typeof raw.transaction !== "string" ||
    !SECRET.test(raw.transaction) ||
    typeof raw.browserHash !== "string" ||
    !timingSafeEqual(raw.browserHash, await sha256(browser.value)) ||
    !raw.continuation ||
    typeof raw.continuation !== "object"
  )
    return null;
  const state = raw as unknown as SignupState;
  if (!state.continuation.finalization || state.continuation.finalization.provider !== "passkey")
    return null;
  return { state, binding: await generateCodeChallenge(`${browser.value}.${state.transaction}`) };
}

export async function readEnrollmentState(
  c: EmailContext,
  signup: SignupState,
): Promise<EnrollmentState | null> {
  const raw = await openNativeCookie(
    getCookie(c, ENROLLMENT_COOKIE),
    c.env.COOKIE_SECRET,
    "email-enrollment",
    c.env.IDP_ORIGIN,
  );
  if (
    !raw ||
    raw.intentId !== signup.intentId ||
    raw.transaction !== signup.transaction ||
    raw.browserHash !== signup.browserHash ||
    typeof raw.authority !== "string" ||
    !SECRET.test(raw.authority) ||
    typeof raw.exp !== "number" ||
    raw.exp > signup.exp ||
    (raw.name !== undefined && !validSignupName(raw.name)) ||
    (raw.pendingId !== undefined &&
      (typeof raw.pendingId !== "string" || !UUID.test(raw.pendingId)))
  )
    return null;
  return raw as unknown as EnrollmentState;
}

export async function installEnrollmentState(c: EmailContext, state: EnrollmentState) {
  setCookie(
    c,
    ENROLLMENT_COOKIE,
    await sealNativeCookie(
      { ...state },
      c.env.COOKIE_SECRET,
      "email-enrollment",
      c.env.IDP_ORIGIN,
      state.exp,
    ),
    { ...OPTIONS, maxAge: state.exp - Math.floor(Date.now() / 1000) },
  );
}
export function clearSignupState(c: EmailContext) {
  for (const name of [BROWSER_COOKIE, SIGNUP_COOKIE, ENROLLMENT_COOKIE])
    deleteCookie(c, name, OPTIONS);
}
