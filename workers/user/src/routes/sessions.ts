import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  fetchWithAuth,
  proxyGet,
  proxyMutate,
  proxyResponse,
  parseSession,
  restErrorBody,
  sha256,
  UUID_RE,
  COOKIE_NAMES,
} from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/me/sessions — アクティブセッション一覧
app.get(
  "/",
  proxyGet(COOKIE_NAMES.USER_SESSION, (c) => `${c.env.IDP_ORIGIN}/api/users/me/tokens`),
);

// DELETE /api/me/sessions/others — 現在のセッション以外の全セッションを終了
app.delete("/others", async (c) => {
  const session = await parseSession(getCookie(c, COOKIE_NAMES.USER_SESSION), c.env.SESSION_SECRET);
  if (!session) {
    return c.json(restErrorBody("UNAUTHORIZED", "Not authenticated"), 401);
  }
  const tokenHash = await sha256(session.refresh_token);
  const res = await fetchWithAuth(
    c,
    COOKIE_NAMES.USER_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/me/tokens/others`,
    {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Origin: c.env.IDP_ORIGIN,
      },
      body: JSON.stringify({ token_hash: tokenHash }),
    },
  );
  return proxyResponse(res);
});

// DELETE /api/me/sessions/:sessionId — 特定セッションのみログアウト
app.delete("/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!UUID_RE.test(sessionId)) {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid session ID format"), 400);
  }
  return proxyMutate(
    c,
    COOKIE_NAMES.USER_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/me/tokens/${sessionId}`,
  );
});

// DELETE /api/me/sessions — 全デバイスからログアウト（全リフレッシュトークン無効化）
app.delete("/", async (c) => {
  return proxyMutate(c, COOKIE_NAMES.USER_SESSION, `${c.env.IDP_ORIGIN}/api/users/me/tokens`);
});

export default app;
