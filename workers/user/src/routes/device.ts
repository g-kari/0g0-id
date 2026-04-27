import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  parseSession,
  createLogger,
  internalServiceHeaders,
  logUpstreamDeprecation,
  restErrorBody,
  COOKIE_NAMES,
} from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

const app = new Hono<{ Bindings: BffEnv }>();

const deviceLogger = createLogger("user-device");

const USER_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

// POST /api/device/verify — ユーザーコード検証
// セッションCookieからユーザー認証を確認し、IdPにuser_codeを転送する
app.post("/verify", async (c): Promise<Response> => {
  const session = await parseSession(getCookie(c, COOKIE_NAMES.USER_SESSION), c.env.SESSION_SECRET);
  if (!session) {
    return c.json(restErrorBody("UNAUTHORIZED", "Not authenticated"), 401);
  }

  let body: { user_code?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid request body"), 400);
  }

  const userCode = typeof body.user_code === "string" ? body.user_code.trim().toUpperCase() : "";
  if (!USER_CODE_PATTERN.test(userCode)) {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid user code format"), 400);
  }

  let idpRes: Response;
  try {
    idpRes = await c.env.IDP.fetch(
      new Request(`${c.env.IDP_ORIGIN}/api/device/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
          ...internalServiceHeaders(c.env),
        },
        body: JSON.stringify({ user_code: userCode }),
      }),
    );
  } catch (err) {
    deviceLogger.error("[verify] Failed to reach IdP", err);
    return c.json(restErrorBody("UPSTREAM_ERROR", "Failed to reach identity provider"), 502);
  }
  logUpstreamDeprecation(idpRes, { method: "POST", path: "/api/device/verify" }, deviceLogger);

  // IdPのレスポンスをそのまま返す
  const responseData: unknown = await idpRes.json();
  return c.json(responseData, idpRes.status as 200 | 400 | 404 | 409 | 500);
});

// POST /api/device/approve — 承認/拒否
// セッションCookieからユーザー認証を確認し、IdPにapprove/denyを転送する
app.post("/approve", async (c): Promise<Response> => {
  const session = await parseSession(getCookie(c, COOKIE_NAMES.USER_SESSION), c.env.SESSION_SECRET);
  if (!session) {
    return c.json(restErrorBody("UNAUTHORIZED", "Not authenticated"), 401);
  }

  let body: { user_code?: string; action?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid request body"), 400);
  }

  const userCode = typeof body.user_code === "string" ? body.user_code.trim().toUpperCase() : "";
  if (!USER_CODE_PATTERN.test(userCode)) {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid user code format"), 400);
  }

  const action = body.action;
  if (action !== "approve" && action !== "deny") {
    return c.json(restErrorBody("BAD_REQUEST", 'action must be "approve" or "deny"'), 400);
  }

  let idpRes: Response;
  try {
    idpRes = await c.env.IDP.fetch(
      new Request(`${c.env.IDP_ORIGIN}/api/device/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
          ...internalServiceHeaders(c.env),
        },
        body: JSON.stringify({ user_code: userCode, action }),
      }),
    );
  } catch (err) {
    deviceLogger.error("[approve] Failed to reach IdP", err);
    return c.json(restErrorBody("UPSTREAM_ERROR", "Failed to reach identity provider"), 502);
  }
  logUpstreamDeprecation(idpRes, { method: "POST", path: "/api/device/verify" }, deviceLogger);

  const responseData: unknown = await idpRes.json();
  return c.json(responseData, idpRes.status as 200 | 400 | 404 | 409 | 500);
});

export default app;
