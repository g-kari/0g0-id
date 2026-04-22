import { Hono } from "hono";
import {
  fetchWithAuth,
  fetchWithJsonBody,
  isValidProvider,
  parseDays,
  proxyGet,
  proxyMutate,
  proxyResponse,
  requirePagination,
  REST_ERROR_CODES,
  UUID_RE,
  uuidParamMiddleware,
  COOKIE_NAMES,
} from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

const app = new Hono<{ Bindings: BffEnv }>();

// ユーザーID形式検証ミドルウェア（:id パラメータを持つすべてのルートに適用）
app.use("/:id", uuidParamMiddleware("id", { label: "user ID" }));
app.use("/:id/*", uuidParamMiddleware("id", { label: "user ID" }));

// GET /api/users
app.get("/", async (c) => {
  const pagination = requirePagination(c, { defaultLimit: 50, maxLimit: 100 });
  if (pagination instanceof Response) return pagination;
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users`);
  url.searchParams.set("limit", String(pagination.limit));
  url.searchParams.set("offset", String(pagination.offset));
  const email = c.req.query("email");
  const role = c.req.query("role");
  const name = c.req.query("name");
  const banned = c.req.query("banned");
  if (email) url.searchParams.set("email", email);
  if (role) url.searchParams.set("role", role);
  if (name) url.searchParams.set("name", name);
  if (banned === "true" || banned === "false") url.searchParams.set("banned", banned);

  const res = await fetchWithAuth(c, COOKIE_NAMES.ADMIN_SESSION, url.toString());
  return proxyResponse(res);
});

// GET /api/users/:id
app.get(
  "/:id",
  proxyGet(COOKIE_NAMES.ADMIN_SESSION, (c) => `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}`),
);

// GET /api/users/:id/owned-services — ユーザーが所有するサービス一覧
app.get(
  "/:id/owned-services",
  proxyGet(
    COOKIE_NAMES.ADMIN_SESSION,
    (c) => `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/owned-services`,
  ),
);

// GET /api/users/:id/services — ユーザーが認可しているサービス一覧
app.get(
  "/:id/services",
  proxyGet(
    COOKIE_NAMES.ADMIN_SESSION,
    (c) => `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/services`,
  ),
);

// GET /api/users/:id/providers — ユーザーのSNSプロバイダー連携状態
app.get(
  "/:id/providers",
  proxyGet(
    COOKIE_NAMES.ADMIN_SESSION,
    (c) => `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/providers`,
  ),
);

// GET /api/users/:id/login-history
app.get("/:id/login-history", async (c) => {
  const pagination = requirePagination(c, { defaultLimit: 20, maxLimit: 100 });
  if (pagination instanceof Response) return pagination;
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/login-history`);
  url.searchParams.set("limit", String(pagination.limit));
  url.searchParams.set("offset", String(pagination.offset));
  const provider = c.req.query("provider");
  if (provider) {
    if (!isValidProvider(provider)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid provider" } }, 400);
    }
    url.searchParams.set("provider", provider);
  }
  const res = await fetchWithAuth(c, COOKIE_NAMES.ADMIN_SESSION, url.toString());
  return proxyResponse(res);
});

// GET /api/users/:id/login-stats — ユーザーのプロバイダー別ログイン統計
app.get("/:id/login-stats", async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/login-stats`);
  const daysResult = parseDays(c.req.query("days"));
  if (daysResult !== undefined) {
    if ("error" in daysResult) {
      return c.json(
        { error: { code: REST_ERROR_CODES.INVALID_PARAMETER, message: daysResult.error } },
        400,
      );
    }
    url.searchParams.set("days", String(daysResult.days));
  }
  const res = await fetchWithAuth(c, COOKIE_NAMES.ADMIN_SESSION, url.toString());
  return proxyResponse(res);
});

// GET /api/users/:id/login-trends — ユーザーの日別ログイントレンド
app.get("/:id/login-trends", async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/login-trends`);
  const daysResult = parseDays(c.req.query("days"));
  if (daysResult !== undefined) {
    if ("error" in daysResult) {
      return c.json(
        { error: { code: REST_ERROR_CODES.INVALID_PARAMETER, message: daysResult.error } },
        400,
      );
    }
    url.searchParams.set("days", String(daysResult.days));
  }
  const res = await fetchWithAuth(c, COOKIE_NAMES.ADMIN_SESSION, url.toString());
  return proxyResponse(res);
});

// GET /api/users/:id/tokens — ユーザーのアクティブセッション一覧
app.get(
  "/:id/tokens",
  proxyGet(
    COOKIE_NAMES.ADMIN_SESSION,
    (c) => `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/tokens`,
  ),
);

// GET /api/users/:id/bff-sessions — ユーザーの BFF セッション一覧（DBSC バインド状態含む）
app.get(
  "/:id/bff-sessions",
  proxyGet(
    COOKIE_NAMES.ADMIN_SESSION,
    (c) => `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/bff-sessions`,
  ),
);

// DELETE /api/users/:id/bff-sessions/:sessionId — 単一の BFF セッションを失効（管理者強制ログアウト）
app.delete("/:id/bff-sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!UUID_RE.test(sessionId)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid session ID format" } }, 400);
  }
  return proxyMutate(
    c,
    COOKIE_NAMES.ADMIN_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/bff-sessions/${sessionId}`,
  );
});

// DELETE /api/users/:id/tokens/:tokenId — ユーザーの特定セッションを失効
app.delete("/:id/tokens/:tokenId", async (c) => {
  const tokenId = c.req.param("tokenId");
  if (!UUID_RE.test(tokenId)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid token ID format" } }, 400);
  }
  return proxyMutate(
    c,
    COOKIE_NAMES.ADMIN_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/tokens/${tokenId}`,
  );
});

// DELETE /api/users/:id/tokens — ユーザーの全セッション無効化
app.delete("/:id/tokens", async (c) => {
  return proxyMutate(
    c,
    COOKIE_NAMES.ADMIN_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/tokens`,
  );
});

// PATCH /api/users/:id/role
app.patch("/:id/role", async (c) => {
  return fetchWithJsonBody(
    c,
    COOKIE_NAMES.ADMIN_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/role`,
    "PATCH",
  );
});

// PATCH /api/users/:id/ban — ユーザーを停止
app.patch("/:id/ban", async (c) => {
  return proxyMutate(
    c,
    COOKIE_NAMES.ADMIN_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/ban`,
    "PATCH",
  );
});

// DELETE /api/users/:id/ban — ユーザー停止を解除
app.delete("/:id/ban", async (c) => {
  return proxyMutate(
    c,
    COOKIE_NAMES.ADMIN_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/ban`,
  );
});

// GET /api/users/:id/lockout — ロックアウト状態取得
app.get(
  "/:id/lockout",
  proxyGet(
    COOKIE_NAMES.ADMIN_SESSION,
    (c) => `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/lockout`,
  ),
);

// DELETE /api/users/:id/lockout — ロックアウト解除
app.delete("/:id/lockout", async (c) => {
  return proxyMutate(
    c,
    COOKIE_NAMES.ADMIN_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}/lockout`,
  );
});

// DELETE /api/users/:id
app.delete("/:id", async (c) => {
  return proxyMutate(
    c,
    COOKIE_NAMES.ADMIN_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param("id")}`,
  );
});

export default app;
