import { Hono } from "hono";
import { fetchWithAuth, proxyResponse, restErrorBody, COOKIE_NAMES } from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

const app = new Hono<{ Bindings: BffEnv }>();

const USER_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function parseUserCode(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return USER_CODE_PATTERN.test(s) ? s : null;
}

// POST /api/device/verify — ユーザーコード検証
app.post("/verify", async (c): Promise<Response> => {
  let body: { user_code?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid request body"), 400);
  }

  const userCode = parseUserCode(body.user_code);
  if (!userCode) {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid user code format"), 400);
  }

  const res = await fetchWithAuth(
    c,
    COOKIE_NAMES.USER_SESSION,
    `${c.env.IDP_ORIGIN}/api/device/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode }),
    },
  );
  return proxyResponse(res);
});

// POST /api/device/approve — 承認/拒否
app.post("/approve", async (c): Promise<Response> => {
  let body: { user_code?: string; action?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid request body"), 400);
  }

  const userCode = parseUserCode(body.user_code);
  if (!userCode) {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid user code format"), 400);
  }

  const action = body.action;
  if (action !== "approve" && action !== "deny") {
    return c.json(restErrorBody("BAD_REQUEST", 'action must be "approve" or "deny"'), 400);
  }

  const res = await fetchWithAuth(
    c,
    COOKIE_NAMES.USER_SESSION,
    `${c.env.IDP_ORIGIN}/api/device/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode, action }),
    },
  );
  return proxyResponse(res);
});

export default app;
