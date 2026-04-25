import { Hono } from "hono";

import { getCookie, deleteCookie } from "hono/cookie";
import type { BffEnv } from "@0g0-id/shared";

// ASSETS binding: Cloudflare Workers Assets を Service Binding として使用
type AdminEnv = BffEnv & { ASSETS: Fetcher };
import {
  logger,
  securityHeaders,
  bodyLimitMiddleware,
  bffCorsMiddleware,
  bffCsrfMiddleware,
  createLogger,
  parseSession,
  validateBffEnv,
  requireDbscBoundSession,
  COOKIE_NAMES,
  SESSION_COOKIE_DELETE_OPTIONS,
} from "@0g0-id/shared";
import authRoutes from "./routes/auth";
import dbscRoutes from "./routes/dbsc";
import servicesRoutes from "./routes/services";
import usersRoutes from "./routes/users";
import metricsRoutes from "./routes/metrics";
import securityTrendsRoutes from "./routes/security-trends";
import auditLogsRoutes from "./routes/audit-logs";

const appLogger = createLogger("admin");

const app = new Hono<{ Bindings: AdminEnv }>();

// SESSION_SECRET の最小長バリデーション（起動時チェック）
app.use("*", async (c, next) => {
  validateBffEnv(c.env);
  await next();
});

app.use("*", logger());
app.use("*", securityHeaders());
app.use("*", bodyLimitMiddleware());

// 管理画面APIへのCORSを管理画面自身のドメインのみに制限
app.use("/api/*", bffCorsMiddleware);

// 外部サービスからのAPIアクセスを禁止（Originヘッダー検証）
// /api/* および /auth/logout に適用（強制ログアウトCSRF対策）
app.use("/api/*", bffCsrfMiddleware);
app.use("/auth/logout", bffCsrfMiddleware);
// /auth/dbsc/* はブラウザ主導（Chrome 内部）の DBSC フローで、リクエストの
// Origin ヘッダが付かない／"null" になり得るため bffCsrfMiddleware を適用しない。
// 代わりに以下の多層で攻撃者からの誤バインドを防ぐ:
//   1. __Host-admin-session Cookie 必須（SameSite=Lax のため、攻撃者サイト発の
//      cross-site fetch には添付されず、ログイン済みユーザーのブラウザ以外からは無効）
//   2. 登録 JWT が ES256 自署 (proof of possession) かつ audience=SELF_ORIGIN を要求
//   3. IdP /auth/dbsc/bind 側で session.bff_origin と X-BFF-Origin が一致する場合のみ受理

// 管理者ロール検証ミドルウェア（多層防御）
// IdP側でroleがadminから降格されたセッションを早期拒否する
app.use("/api/*", async (c, next) => {
  const cookie = getCookie(c, COOKIE_NAMES.ADMIN_SESSION);
  const session = await parseSession(cookie, c.env.SESSION_SECRET);
  if (!session) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
  }
  if (session.user.role !== "admin") {
    deleteCookie(c, COOKIE_NAMES.ADMIN_SESSION, SESSION_COOKIE_DELETE_OPTIONS);
    return c.json({ error: { code: "FORBIDDEN", message: "Forbidden" } }, 403);
  }
  await next();
});

// DBSC 必須化ミドルウェア（Phase 3 — 機密操作への段階的導入）。
// 破壊的メソッド（POST/PATCH/PUT/DELETE）のみ DBSC バインド状態を IdP に問い合わせる。
// デフォルトは warn-only（未バインドでも通過・ログのみ）で、
// `DBSC_ENFORCE_SENSITIVE="true"` を設定した環境のみ 403 で拒否する。
// services/users の全破壊的操作に適用することで、管理画面側の機密度を底上げする。
const dbscRequire = requireDbscBoundSession({
  sessionCookieName: COOKIE_NAMES.ADMIN_SESSION,
  loggerName: "admin-dbsc-enforce",
  enforce: "env",
  registrationPath: "/auth/dbsc/start",
});
app.use("/api/services/*", dbscRequire);
app.use("/api/users/*", dbscRequire);

app.route("/auth", authRoutes);
app.route("/auth/dbsc", dbscRoutes);
app.route("/api/services", servicesRoutes);
app.route("/api/users", usersRoutes);
app.route("/api/metrics", metricsRoutes);
app.route("/api/security-trends", securityTrendsRoutes);
app.route("/api/audit-logs", auditLogsRoutes);

app.get("/api/health", (c) => {
  return c.json({ status: "ok", worker: "admin", timestamp: new Date().toISOString() });
});

// /api/* の未定義 GET ルートは 404 を返す（SPA fallback に流れないようにする）
app.get("/api/*", (c) => {
  return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
});

// MPA フォールバック: /api/* と /auth/* 以外は対応するHTMLを返す
// Astro MPA は /profile → /profile/index.html のようにディレクトリ構造で出力する
// 動的ルート（/users/:uuid 等）は対応する detail ページにリライトする
const UUID_DETAIL_RE = /^\/([^/]+)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  // /users/:uuid → /users/detail/index.html（動的ルートのリライト）
  const match = UUID_DETAIL_RE.exec(path);
  const resolved = match ? `/${match[1]}/detail/index.html` : path;
  const htmlPath =
    resolved === "/" || resolved.endsWith(".html") ? resolved : `${resolved}/index.html`;
  const url = new URL(htmlPath, c.req.url);
  return c.env.ASSETS.fetch(new Request(url.toString()));
});

app.onError((err, c) => {
  appLogger.error("Unhandled error", err);
  return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
});

export default app;
