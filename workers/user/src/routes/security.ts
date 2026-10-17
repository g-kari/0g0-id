import { Hono } from "hono";
import {
  fetchWithAuth,
  parseDays,
  proxyGet,
  proxyResponse,
  restErrorBody,
  REST_ERROR_CODES,
  COOKIE_NAMES,
} from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/me/security/summary — セキュリティ概要（アクティブセッション数・連携サービス数・最終ログインなど）
app.get(
  "/summary",
  proxyGet(COOKIE_NAMES.USER_SESSION, (c) => `${c.env.IDP_ORIGIN}/api/users/me/security-summary`),
);

// GET /api/me/security/login-stats — プロバイダー別ログイン統計（days: 1〜365、デフォルト30）
app.get("/login-stats", async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/me/login-stats`);
  const daysResult = parseDays(c.req.query("days"), { maxDays: 365 });
  if (daysResult !== undefined) {
    if ("error" in daysResult) {
      return c.json(
        restErrorBody(REST_ERROR_CODES.INVALID_PARAMETER, daysResult.error.message),
        400,
      );
    }
    url.searchParams.set("days", String(daysResult.days));
  }
  const res = await fetchWithAuth(c, COOKIE_NAMES.USER_SESSION, url.toString());
  return proxyResponse(res);
});

// GET /api/me/security/login-trends — 日別ログイントレンド（days: 1〜365、デフォルト30）
app.get("/login-trends", async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/me/login-trends`);
  const daysResult = parseDays(c.req.query("days"), { maxDays: 365 });
  if (daysResult !== undefined) {
    if ("error" in daysResult) {
      return c.json(
        restErrorBody(REST_ERROR_CODES.INVALID_PARAMETER, daysResult.error.message),
        400,
      );
    }
    url.searchParams.set("days", String(daysResult.days));
  }
  const res = await fetchWithAuth(c, COOKIE_NAMES.USER_SESSION, url.toString());
  return proxyResponse(res);
});

export default app;
