import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  generateToken,
  isValidProvider,
  parseSession,
  createLogger,
  internalServiceHeaders,
  setOAuthStateCookie,
  createBffAuthRoutes,
  logUpstreamDeprecation,
} from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

const userAuthLogger = createLogger("user-auth");

const SESSION_COOKIE = "__Host-user-session";
const STATE_COOKIE = "__Host-user-oauth-state";

// 共通認証ルート（login / callback / logout）
const authRoutes = createBffAuthRoutes({
  sessionCookieName: SESSION_COOKIE,
  stateCookieName: STATE_COOKIE,
  loggerName: "user-auth",
  successRedirect: "/profile",
  // Chrome 等の DBSC 対応ブラウザに端末バインド登録フローを開始させる
  dbscRegistrationPath: "/auth/dbsc/start",
  loginParams: (c) => {
    const provider = c.req.query("provider") ?? "google";
    if (!isValidProvider(provider)) {
      return c.redirect("/?error=invalid_provider");
    }
    return { provider };
  },
});

const app = new Hono<{ Bindings: BffEnv }>();

// 共通ルートをマウント
app.route("/", authRoutes);

// POST /auth/link — ログイン済みユーザーがSNSプロバイダー連携を開始
// GETではなくPOSTにすることでbffCsrfMiddlewareによるOriginヘッダー検証を適用し、
// クロスサイトからの強制ナビゲーションによるアカウントリンク攻撃を防止する
app.post("/link", async (c) => {
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, string>);
  const provider = (body["provider"] as string) ?? c.req.query("provider") ?? "google";
  if (!isValidProvider(provider)) {
    return c.redirect("/profile?error=invalid_provider");
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
    logUpstreamDeprecation(res, { method: "POST", path: "/auth/link-intent" }, userAuthLogger);
    if (!res.ok) {
      return c.redirect("/profile?error=link_failed");
    }
    const data = await res.json<{ data: { link_token: string } }>();
    linkToken = data.data.link_token;
  } catch (err) {
    userAuthLogger.error("[link] Failed to obtain link token from IdP", err);
    return c.redirect("/profile?error=link_failed");
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
