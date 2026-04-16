import { Hono } from "hono";
import {
  fetchWithAuth,
  fetchWithJsonBody,
  parsePagination,
  proxyMutate,
  proxyResponse,
  UUID_RE,
  uuidParamMiddleware,
} from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";
import { SESSION_COOKIE } from "./auth";

const app = new Hono<{ Bindings: BffEnv }>();

// サービスID形式検証ミドルウェア（:id パラメータを持つすべてのルートに適用）
app.use("/:id", uuidParamMiddleware("id", { label: "service ID" }));
app.use("/:id/*", uuidParamMiddleware("id", { label: "service ID" }));

// GET /api/services
app.get("/", async (c) => {
  const limitRaw = c.req.query("limit");
  const offsetRaw = c.req.query("offset");
  const pagination = parsePagination(
    { limit: limitRaw, offset: offsetRaw },
    { defaultLimit: 50, maxLimit: 100 },
  );
  if ("error" in pagination) {
    return c.json({ error: pagination.error }, 400);
  }
  const url = new URL(`${c.env.IDP_ORIGIN}/api/services`);
  if (limitRaw !== undefined) url.searchParams.set("limit", String(pagination.limit));
  if (offsetRaw !== undefined) url.searchParams.set("offset", String(pagination.offset));
  const name = c.req.query("name");
  if (name) url.searchParams.set("name", name);
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

// GET /api/services/:id
app.get("/:id", async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param("id")}`,
  );
  return proxyResponse(res);
});

// POST /api/services
app.post("/", async (c) => {
  return fetchWithJsonBody(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/services`, "POST");
});

// PATCH /api/services/:id — allowed_scopesの更新
app.patch("/:id", async (c) => {
  return fetchWithJsonBody(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param("id")}`,
    "PATCH",
  );
});

// DELETE /api/services/:id
app.delete("/:id", async (c) => {
  return proxyMutate(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/services/${c.req.param("id")}`);
});

// POST /api/services/:id/rotate-secret — client_secretの再発行
app.post("/:id/rotate-secret", async (c) => {
  return proxyMutate(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param("id")}/rotate-secret`,
    "POST",
  );
});

// GET /api/services/:id/redirect-uris
app.get("/:id/redirect-uris", async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param("id")}/redirect-uris`,
  );
  return proxyResponse(res);
});

// POST /api/services/:id/redirect-uris
app.post("/:id/redirect-uris", async (c) => {
  return fetchWithJsonBody(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param("id")}/redirect-uris`,
    "POST",
  );
});

// GET /api/services/:id/users — サービスを認可済みのユーザー一覧
app.get("/:id/users", async (c) => {
  const pagination = parsePagination(
    { limit: c.req.query("limit"), offset: c.req.query("offset") },
    { defaultLimit: 50, maxLimit: 100 },
  );
  if ("error" in pagination) {
    return c.json({ error: pagination.error }, 400);
  }
  const url = new URL(`${c.env.IDP_ORIGIN}/api/services/${c.req.param("id")}/users`);
  url.searchParams.set("limit", String(pagination.limit));
  url.searchParams.set("offset", String(pagination.offset));
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

// DELETE /api/services/:id/users/:userId — ユーザーのサービスアクセスを失効
app.delete("/:id/users/:userId", async (c) => {
  const userId = c.req.param("userId");
  if (!UUID_RE.test(userId)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid user ID format" } }, 400);
  }
  return proxyMutate(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param("id")}/users/${userId}`,
  );
});

// PATCH /api/services/:id/owner — サービス所有権の転送
app.patch("/:id/owner", async (c) => {
  return fetchWithJsonBody(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param("id")}/owner`,
    "PATCH",
  );
});

// DELETE /api/services/:id/redirect-uris/:uriId
app.delete("/:id/redirect-uris/:uriId", async (c) => {
  const uriId = c.req.param("uriId");
  if (!UUID_RE.test(uriId)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid URI ID format" } }, 400);
  }
  return proxyMutate(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param("id")}/redirect-uris/${uriId}`,
  );
});

export default app;
