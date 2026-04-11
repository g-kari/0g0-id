import { Hono } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import {
  generateToken,
  isValidProvider,
  parseSession,
  setSessionCookie,
  createLogger,
  internalServiceHeaders,
  setOAuthStateCookie,
  verifyAndConsumeOAuthState,
  exchangeCodeAtIdp,
  revokeTokenAtIdp,
} from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

const app = new Hono<{ Bindings: BffEnv }>();

const userAuthLogger = createLogger("user-auth");

const SESSION_COOKIE = "__Host-user-session";
const STATE_COOKIE = "__Host-user-oauth-state";

// GET /auth/login
app.get("/login", async (c) => {
  const provider = c.req.query("provider") ?? "google";
  if (!isValidProvider(provider)) {
    return c.redirect("/?error=invalid_provider");
  }

  const state = generateToken(16);
  const callbackUrl = `${c.env.SELF_ORIGIN}/auth/callback`;

  setOAuthStateCookie(c, STATE_COOKIE, state);

  const loginUrl = new URL(`${c.env.IDP_ORIGIN}/auth/login`);
  loginUrl.searchParams.set("redirect_to", callbackUrl);
  loginUrl.searchParams.set("state", state);
  loginUrl.searchParams.set("provider", provider);

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

  // id worker にコード交換リクエスト（Service Bindings使用）
  const callbackUrl = `${c.env.SELF_ORIGIN}/auth/callback`;
  const result = await exchangeCodeAtIdp(c.env, code, callbackUrl);

  if (!result.ok) {
    return c.redirect("/?error=exchange_failed");
  }

  // セッションCookieにトークンを保存
  await setSessionCookie(c, SESSION_COOKIE, {
    access_token: result.data.access_token,
    refresh_token: result.data.refresh_token,
    user: result.data.user,
  });

  return c.redirect("/profile.html");
});

// POST /auth/logout
app.post("/logout", async (c) => {
  const sessionData = await parseSession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET);
  if (sessionData) {
    try {
      await revokeTokenAtIdp(c.env, sessionData.refresh_token);
    } catch (err) {
      // IdP側のトークン失効に失敗してもCookie削除は継続するが、ログに記録する
      userAuthLogger.error("[logout] IdP revoke request failed", err);
    }
  }

  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  return c.redirect("/");
});

// POST /auth/link — ログイン済みユーザーがSNSプロバイダー連携を開始
// GETではなくPOSTにすることでbffCsrfMiddlewareによるOriginヘッダー検証を適用し、
// クロスサイトからの強制ナビゲーションによるアカウントリンク攻撃を防止する
app.post("/link", async (c) => {
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, string>);
  const provider = (body["provider"] as string) ?? c.req.query("provider") ?? "google";
  if (!isValidProvider(provider)) {
    return c.redirect("/profile.html?error=invalid_provider");
  }

  // ログイン済みセッションからアクセストークンを取得
  const session = await parseSession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET);
  if (!session) {
    return c.redirect("/?error=not_authenticated");
  }

  // IdPに対してlink_user_idを直接渡すのはアカウント乗っ取りに悪用可能なため、
  // サーバー側でワンタイムトークンを発行してもらい、それをログインURLに含める
  let linkToken: string;
  try {
    const res = await c.env.IDP.fetch(
      new Request(`${c.env.IDP_ORIGIN}/auth/link-intent`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          ...internalServiceHeaders(c.env),
        },
      }),
    );
    if (!res.ok) {
      return c.redirect("/profile.html?error=link_failed");
    }
    const data = await res.json<{ data: { link_token: string } }>();
    linkToken = data.data.link_token;
  } catch (err) {
    userAuthLogger.error("[link] Failed to obtain link token from IdP", err);
    return c.redirect("/profile.html?error=link_failed");
  }

  const state = generateToken(16);
  const callbackUrl = `${c.env.SELF_ORIGIN}/auth/callback`;

  setOAuthStateCookie(c, STATE_COOKIE, state);

  const loginUrl = new URL(`${c.env.IDP_ORIGIN}/auth/login`);
  loginUrl.searchParams.set("redirect_to", callbackUrl);
  loginUrl.searchParams.set("state", state);
  loginUrl.searchParams.set("provider", provider);
  loginUrl.searchParams.set("link_token", linkToken);

  return c.redirect(loginUrl.toString());
});

export default app;
export { SESSION_COOKIE };
