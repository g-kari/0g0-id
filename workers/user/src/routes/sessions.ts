import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { fetchWithAuth, proxyMutate, proxyResponse, parseSession, sha256 } from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";
import { SESSION_COOKIE } from "./auth";

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/me/sessions — アクティブセッション一覧
app.get("/", async (c) => {
  const res = await fetchWithAuth(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/me/tokens`);
  return proxyResponse(res);
});

// DELETE /api/me/sessions/others — 現在のセッション以外の全セッションを終了
app.delete("/others", async (c) => {
  const session = await parseSession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET);
  if (!session) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } }, 401);
  }
  const tokenHash = await sha256(session.refresh_token);
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
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
  return proxyMutate(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/tokens/${c.req.param("sessionId")}`,
  );
});

// DELETE /api/me/sessions — 全デバイスからログアウト（全リフレッシュトークン無効化）
app.delete("/", async (c) => {
  return proxyMutate(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/me/tokens`);
});

export default app;
