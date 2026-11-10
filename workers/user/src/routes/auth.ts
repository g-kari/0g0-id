import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { html } from "hono/html";
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
import { COOKIE_NAMES } from "@0g0-id/shared";

const userAuthLogger = createLogger("user-auth");

// 共通認証ルート（login / callback / logout）
const authRoutes = createBffAuthRoutes({
  sessionCookieName: COOKIE_NAMES.USER_SESSION,
  stateCookieName: COOKIE_NAMES.USER_STATE,
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
  const session = await parseSession(getCookie(c, COOKIE_NAMES.USER_SESSION), c.env.SESSION_SECRET);
  if (!session) {
    return c.redirect("/?error=not_authenticated");
  }

  // IdPに対してlink_user_idを直接渡すのはアカウント乗っ取りに悪用可能なため、
  // サーバー側でワンタイムトークンを発行してもらい、それをログインURLに含める
  const bindProvider = provider === "discord" || provider === "steam";
  let socialLoginUrl: URL | undefined;
  if (bindProvider) {
    try {
      const origin = new URL(c.env.IDP_ORIGIN);
      if (
        origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      ) {
        return c.text("Invalid authentication service configuration", 503);
      }
      socialLoginUrl = new URL("/auth/login", origin);
    } catch {
      return c.text("Invalid authentication service configuration", 503);
    }
  }
  let linkToken: string;
  try {
    const res = await c.env.IDP.fetch(
      new Request(`${c.env.IDP_ORIGIN}/auth/link-intent`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          ...internalServiceHeaders(c.env),
          ...(bindProvider ? { "Content-Type": "application/json" } : {}),
        },
        ...(bindProvider ? { body: JSON.stringify({ provider }) } : {}),
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

  setOAuthStateCookie(c, COOKIE_NAMES.USER_STATE, state);

  if (socialLoginUrl) {
    // Submit the intent from this origin, never in a transplantable GET URL.
    const nonce = generateToken(24);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "origin");
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${socialLoginUrl.origin}; frame-ancestors 'none'; base-uri 'none'`,
    );
    return c.html(
      html`<!doctype html>
        <html lang="ja">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>アカウント連携 — 0g0 ID</title>
          </head>
          <body>
            <p>アカウント連携を開始します。</p>
            <form id="social-link" method="post" action="${socialLoginUrl.toString()}">
              <input type="hidden" name="redirect_to" value="${callbackUrl}" />
              <input type="hidden" name="state" value="${state}" />
              <input type="hidden" name="provider" value="${provider}" />
              <input type="hidden" name="link_token" value="${linkToken}" />
              <button type="submit">連携を続ける</button>
            </form>
            <script nonce="${nonce}">
              document.getElementById("social-link").submit();
            </script>
          </body>
        </html>`,
    );
  }

  const loginUrl = new URL(`${c.env.IDP_ORIGIN}/auth/login`);
  loginUrl.searchParams.set("redirect_to", callbackUrl);
  loginUrl.searchParams.set("state", state);
  loginUrl.searchParams.set("provider", provider);
  loginUrl.searchParams.set("link_token", linkToken);

  return c.redirect(loginUrl.toString());
});

export default app;
