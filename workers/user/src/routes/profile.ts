import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import {
  fetchWithAuth,
  fetchWithJsonBody,
  isValidProvider,
  parseDays,
  parsePagination,
  proxyResponse,
} from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";
import { SESSION_COOKIE } from "./auth";

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/me
app.get("/", async (c) => {
  const res = await fetchWithAuth(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/me`);
  return proxyResponse(res);
});

// GET /api/me/login-history
app.get("/login-history", async (c) => {
  const pagination = parsePagination(
    { limit: c.req.query("limit"), offset: c.req.query("offset") },
    { defaultLimit: 20, maxLimit: 100 },
  );
  if ("error" in pagination) {
    return c.json({ error: pagination.error }, 400);
  }
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/me/login-history`);
  url.searchParams.set("limit", String(pagination.limit));
  url.searchParams.set("offset", String(pagination.offset));
  const provider = c.req.query("provider");
  if (provider) {
    if (!isValidProvider(provider)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid provider" } }, 400);
    }
    url.searchParams.set("provider", provider);
  }
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

// GET /api/me/login-stats — プロバイダー別ログイン統計
app.get("/login-stats", async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/me/login-stats`);
  const daysResult = parseDays(c.req.query("days"), { maxDays: 365 });
  if (daysResult !== undefined) {
    if ("error" in daysResult) {
      return c.json(
        { error: { code: "INVALID_PARAMETER", message: daysResult.error.message } },
        400,
      );
    }
    url.searchParams.set("days", String(daysResult.days));
  }
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

// GET /api/me/data-export — アカウントデータ一括エクスポート
app.get("/data-export", async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/data-export`,
  );
  return proxyResponse(res);
});

// GET /api/me/security-summary — セキュリティ概要（セッション数・連携サービス数・リンク済みプロバイダー等）
app.get("/security-summary", async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/security-summary`,
  );
  return proxyResponse(res);
});

// PATCH /api/me
app.patch("/", async (c) => {
  return fetchWithJsonBody(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/me`, "PATCH");
});

// DELETE /api/me — アカウント削除（セッションCookieも削除）
app.delete("/", async (c) => {
  const res = await fetchWithAuth(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/me`, {
    method: "DELETE",
    headers: { Origin: c.env.IDP_ORIGIN },
  });
  if (res.status === 204) {
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
    return c.body(null, 204);
  }
  return proxyResponse(res);
});

export default app;
