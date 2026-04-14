import { Hono } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import {
  generateToken,
  parseSession,
  setSessionCookie,
  createLogger,
  setOAuthStateCookie,
  verifyAndConsumeOAuthState,
  exchangeCodeAtIdp,
  revokeTokenAtIdp,
} from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

const app = new Hono<{ Bindings: BffEnv }>();

const adminAuthLogger = createLogger("admin-auth");

const SESSION_COOKIE = "__Host-admin-session";
const STATE_COOKIE = "__Host-admin-oauth-state";

// GET /auth/login
app.get("/login", async (c) => {
  const state = generateToken(16);
  const callbackUrl = `${c.env.SELF_ORIGIN}/auth/callback`;

  setOAuthStateCookie(c, STATE_COOKIE, state);

  const loginUrl = new URL(`${c.env.IDP_ORIGIN}/auth/login`);
  loginUrl.searchParams.set("redirect_to", callbackUrl);
  loginUrl.searchParams.set("state", state);

  return c.redirect(loginUrl.toString());
});

// GET /auth/callback
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.redirect("/?error=missing_params");
  }

  const stateError = verifyAndConsumeOAuthState(c, STATE_COOKIE, state);
  if (stateError) {
    return c.redirect(`/?error=${stateError}`);
  }

  const callbackUrl = `${c.env.SELF_ORIGIN}/auth/callback`;
  const result = await exchangeCodeAtIdp(c.env, code, callbackUrl);

  if (!result.ok) {
    return c.redirect("/?error=exchange_failed");
  }

  // 管理者チェック
  if (result.data.user.role !== "admin") {
    // 非管理者ユーザーのリフレッシュトークンを失効させる（孤立トークン防止）
    try {
      await revokeTokenAtIdp(c.env, result.data.refresh_token);
    } catch (err) {
      // 失効に失敗してもリダイレクトは継続
      adminAuthLogger.warn("[admin-callback] IdP logout request failed for non-admin user", err);
    }
    return c.redirect("/?error=not_admin");
  }

  await setSessionCookie(c, SESSION_COOKIE, {
    access_token: result.data.access_token,
    refresh_token: result.data.refresh_token,
    user: result.data.user,
  });

  return c.redirect("/dashboard");
});

// POST /auth/logout
app.post("/logout", async (c) => {
  const session = getCookie(c, SESSION_COOKIE);
  const sessionData = await parseSession(session, c.env.SESSION_SECRET);
  if (sessionData) {
    try {
      await revokeTokenAtIdp(c.env, sessionData.refresh_token);
    } catch (err) {
      // IdP側のトークン失効に失敗してもCookie削除は継続するが、ログに記録する
      adminAuthLogger.error("[logout] IdP revoke request failed", err);
    }
  }

  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  return c.redirect("/");
});

export default app;
export { SESSION_COOKIE };
