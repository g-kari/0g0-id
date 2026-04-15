import { Hono } from "hono";

import type { BffEnv } from "@0g0-id/shared";

// ASSETS binding: Cloudflare Workers Assets を Service Binding として使用
type UserEnv = BffEnv & { ASSETS: Fetcher };
import {
  logger,
  securityHeaders,
  bodyLimitMiddleware,
  bffCorsMiddleware,
  bffCsrfMiddleware,
  createLogger,
} from "@0g0-id/shared";
import authRoutes from "./routes/auth";
import oauthRoutes from "./routes/oauth";
import profileRoutes from "./routes/profile";
import connectionsRoutes from "./routes/connections";
import providersRoutes from "./routes/providers";
import loginHistoryRoutes from "./routes/login-history";
import sessionsRoutes from "./routes/sessions";
import securityRoutes from "./routes/security";
import deviceRoutes from "./routes/device";

const appLogger = createLogger("user");

const app = new Hono<{ Bindings: UserEnv }>();

app.use("*", logger());
app.use("*", securityHeaders());
app.use("*", bodyLimitMiddleware());

// ユーザー画面APIへのCORSをユーザー画面自身のドメインのみに制限
app.use("/api/*", bffCorsMiddleware);

// 外部サービスからのAPIアクセスを禁止（Originヘッダー検証）
// /api/* および /auth/logout に適用（強制ログアウトCSRF対策）
app.use("/api/*", bffCsrfMiddleware);
app.use("/auth/logout", bffCsrfMiddleware);
app.use("/auth/link", bffCsrfMiddleware);

app.route("/auth", authRoutes);
// OAuth 2.0 / OIDC フロー: IdP の /auth/authorize からリダイレクトされるプロバイダー選択ページ
app.route("/", oauthRoutes);
app.route("/api/me", profileRoutes);
app.route("/api/connections", connectionsRoutes);
app.route("/api/providers", providersRoutes);
app.route("/api/login-history", loginHistoryRoutes);
app.route("/api/me/sessions", sessionsRoutes);
app.route("/api/me/security", securityRoutes);
app.route("/api/device", deviceRoutes);

app.get("/api/health", (c) => {
  return c.json({ status: "ok", worker: "user", timestamp: new Date().toISOString() });
});

// /api/* の未定義 GET ルートは 404 を返す（SPA fallback に流れないようにする）
app.get("/api/*", (c) => {
  return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
});

// MPA フォールバック: /api/* と /auth/* 以外は対応するHTMLを返す
// Astro MPA は /profile → /profile/index.html のようにディレクトリ構造で出力する
app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  // /profile → /profile/index.html, / → /index.html
  const htmlPath = path === "/" || path.endsWith(".html") ? path : `${path}/index.html`;
  const url = new URL(htmlPath, c.req.url);
  return c.env.ASSETS.fetch(new Request(url.toString()));
});

app.onError((err, c) => {
  appLogger.error("Unhandled error", err);
  return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
});

export default app;
