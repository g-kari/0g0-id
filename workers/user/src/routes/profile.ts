import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import {
  fetchWithAuth,
  fetchWithJsonBody,
  isValidProvider,
  parseDays,
  paginationMiddleware,
  proxyGet,
  proxyResponse,
  REST_ERROR_CODES,
  SESSION_COOKIE_DELETE_OPTIONS,
} from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";
import { COOKIE_NAMES } from "@0g0-id/shared";

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/me
app.get(
  "/",
  proxyGet(COOKIE_NAMES.USER_SESSION, (c) => `${c.env.IDP_ORIGIN}/api/users/me`),
);

// GET /api/me/login-history
app.get("/login-history", paginationMiddleware({ defaultLimit: 20, maxLimit: 100 }), async (c) => {
  const { limit, offset } = c.get("pagination");
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/me/login-history`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  const provider = c.req.query("provider");
  if (provider) {
    if (!isValidProvider(provider)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid provider" } }, 400);
    }
    url.searchParams.set("provider", provider);
  }
  const res = await fetchWithAuth(c, COOKIE_NAMES.USER_SESSION, url.toString());
  return proxyResponse(res);
});

// GET /api/me/login-stats — プロバイダー別ログイン統計
app.get("/login-stats", async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/me/login-stats`);
  const daysResult = parseDays(c.req.query("days"), { maxDays: 365 });
  if (daysResult !== undefined) {
    if ("error" in daysResult) {
      return c.json(
        { error: { code: REST_ERROR_CODES.INVALID_PARAMETER, message: daysResult.error.message } },
        400,
      );
    }
    url.searchParams.set("days", String(daysResult.days));
  }
  const res = await fetchWithAuth(c, COOKIE_NAMES.USER_SESSION, url.toString());
  return proxyResponse(res);
});

// GET /api/me/data-export — アカウントデータ一括エクスポート
app.get(
  "/data-export",
  proxyGet(COOKIE_NAMES.USER_SESSION, (c) => `${c.env.IDP_ORIGIN}/api/users/me/data-export`),
);

// GET /api/me/security-summary — セキュリティ概要（セッション数・連携サービス数・リンク済みプロバイダー等）
app.get(
  "/security-summary",
  proxyGet(COOKIE_NAMES.USER_SESSION, (c) => `${c.env.IDP_ORIGIN}/api/users/me/security-summary`),
);

// PATCH /api/me
app.patch("/", async (c) => {
  return fetchWithJsonBody(
    c,
    COOKIE_NAMES.USER_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/me`,
    "PATCH",
  );
});

// DELETE /api/me — アカウント削除（セッションCookieも削除）
app.delete("/", async (c) => {
  const res = await fetchWithAuth(
    c,
    COOKIE_NAMES.USER_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/me`,
    {
      method: "DELETE",
      headers: { Origin: c.env.IDP_ORIGIN },
    },
  );
  if (res.status === 204) {
    deleteCookie(c, COOKIE_NAMES.USER_SESSION, SESSION_COOKIE_DELETE_OPTIONS);
    return c.body(null, 204);
  }
  return proxyResponse(res);
});

export default app;
