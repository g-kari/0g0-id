import { Hono } from "hono";
import {
  fetchWithAuth,
  parseDays,
  proxyResponse,
  REST_ERROR_CODES,
  COOKIE_NAMES,
} from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

const app = new Hono<{ Bindings: BffEnv }>();

// limit の共通バリデーション（1〜100の整数）
function applyLimit(url: URL, limitRaw: string | undefined): Response | undefined {
  if (limitRaw === undefined) return undefined;
  if (!/^\d+$/.test(limitRaw)) {
    return Response.json(
      {
        error: {
          code: REST_ERROR_CODES.INVALID_PARAMETER,
          message: "limit must be a positive integer",
        },
      },
      { status: 400 },
    );
  }
  const limit = parseInt(limitRaw, 10);
  if (limit < 1 || limit > 100) {
    return Response.json(
      {
        error: {
          code: REST_ERROR_CODES.INVALID_PARAMETER,
          message: "limit must be between 1 and 100",
        },
      },
      { status: 400 },
    );
  }
  url.searchParams.set("limit", String(limit));
  return undefined;
}

// offset の共通バリデーション（0以上の整数）
function applyOffset(url: URL, offsetRaw: string | undefined): Response | undefined {
  if (offsetRaw === undefined) return undefined;
  if (!/^\d+$/.test(offsetRaw)) {
    return Response.json(
      {
        error: {
          code: REST_ERROR_CODES.INVALID_PARAMETER,
          message: "offset must be a non-negative integer",
        },
      },
      { status: 400 },
    );
  }
  const offset = parseInt(offsetRaw, 10);
  if (offset < 0) {
    return Response.json(
      {
        error: {
          code: REST_ERROR_CODES.INVALID_PARAMETER,
          message: "offset must be a non-negative integer",
        },
      },
      { status: 400 },
    );
  }
  url.searchParams.set("offset", String(offset));
  return undefined;
}

// GET /api/security-trends/ip-stats?days=7&limit=20 — IPアドレス別ログイン統計
app.get("/ip-stats", async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/metrics/ip-stats`);
  const daysResult = parseDays(c.req.query("days"), { maxDays: 365 });
  if (daysResult !== undefined) {
    if ("error" in daysResult) {
      return c.json(
        { error: { code: REST_ERROR_CODES.INVALID_PARAMETER, message: daysResult.error } },
        400,
      );
    }
    url.searchParams.set("days", String(daysResult.days));
  }
  const limitErr = applyLimit(url, c.req.query("limit"));
  if (limitErr) return limitErr;

  const res = await fetchWithAuth(c, COOKIE_NAMES.ADMIN_SESSION, url.toString());
  return proxyResponse(res);
});

// GET /api/security-trends/user-agent-stats?days=7&limit=20 — User-Agent別ログイン統計
app.get("/user-agent-stats", async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/metrics/user-agent-stats`);
  const daysResult = parseDays(c.req.query("days"), { maxDays: 365 });
  if (daysResult !== undefined) {
    if ("error" in daysResult) {
      return c.json(
        { error: { code: REST_ERROR_CODES.INVALID_PARAMETER, message: daysResult.error } },
        400,
      );
    }
    url.searchParams.set("days", String(daysResult.days));
  }
  const limitErr = applyLimit(url, c.req.query("limit"));
  if (limitErr) return limitErr;

  const res = await fetchWithAuth(c, COOKIE_NAMES.ADMIN_SESSION, url.toString());
  return proxyResponse(res);
});

// GET /api/security-trends/recent-events?limit=50&offset=0 — 全ユーザーの直近ログインイベント一覧
app.get("/recent-events", async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/metrics/recent-events`);
  const limitErr = applyLimit(url, c.req.query("limit"));
  if (limitErr) return limitErr;
  const offsetErr = applyOffset(url, c.req.query("offset"));
  if (offsetErr) return offsetErr;

  const res = await fetchWithAuth(c, COOKIE_NAMES.ADMIN_SESSION, url.toString());
  return proxyResponse(res);
});

export default app;
