import { Hono } from "hono";
import { fetchWithAuth, parseDays, proxyResponse } from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";
import { SESSION_COOKIE } from "./auth";

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/metrics
app.get("/", async (c) => {
  const res = await fetchWithAuth(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/metrics`);
  return proxyResponse(res);
});

// GET /api/metrics/login-trends?days=30
app.get("/login-trends", async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/metrics/login-trends`);
  const daysResult = parseDays(c.req.query("days"));
  if (daysResult !== undefined) {
    if ("error" in daysResult) {
      return c.json({ error: { code: "INVALID_PARAMETER", message: daysResult.error } }, 400);
    }
    url.searchParams.set("days", String(daysResult.days));
  }
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

// GET /api/metrics/services — サービス別アクティブトークン統計
app.get("/services", async (c) => {
  const res = await fetchWithAuth(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/metrics/services`);
  return proxyResponse(res);
});

// GET /api/metrics/suspicious-logins?hours=24&min_countries=2
app.get("/suspicious-logins", async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/metrics/suspicious-logins`);
  const hoursRaw = c.req.query("hours");
  if (hoursRaw !== undefined) {
    if (!/^\d+$/.test(hoursRaw)) {
      return c.json(
        { error: { code: "INVALID_PARAMETER", message: "hours must be a positive integer" } },
        400,
      );
    }
    const hours = parseInt(hoursRaw, 10);
    if (hours < 1 || hours > 720) {
      return c.json(
        { error: { code: "INVALID_PARAMETER", message: "hours must be between 1 and 720" } },
        400,
      );
    }
    url.searchParams.set("hours", String(hours));
  }
  const minCountriesRaw = c.req.query("min_countries");
  if (minCountriesRaw !== undefined) {
    if (!/^\d+$/.test(minCountriesRaw)) {
      return c.json(
        {
          error: { code: "INVALID_PARAMETER", message: "min_countries must be a positive integer" },
        },
        400,
      );
    }
    const minCountries = parseInt(minCountriesRaw, 10);
    if (minCountries < 1 || minCountries > 100) {
      return c.json(
        {
          error: { code: "INVALID_PARAMETER", message: "min_countries must be between 1 and 100" },
        },
        400,
      );
    }
    url.searchParams.set("min_countries", String(minCountries));
  }
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

// GET /api/metrics/user-registrations?days=30 — 日別新規ユーザー登録数
app.get("/user-registrations", async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/metrics/user-registrations`);
  const daysResult = parseDays(c.req.query("days"));
  if (daysResult !== undefined) {
    if ("error" in daysResult) {
      return c.json({ error: { code: "INVALID_PARAMETER", message: daysResult.error } }, 400);
    }
    url.searchParams.set("days", String(daysResult.days));
  }
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

export default app;
