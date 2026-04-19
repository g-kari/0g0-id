import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { fetchWithAuth, parseSession, proxyResponse, UUID_RE } from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";
import { SESSION_COOKIE } from "./auth";

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/me/bff-sessions — 自分のBFFセッション一覧（DBSC バインド状態を含む）
app.get("/", async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/bff-sessions`,
  );
  return proxyResponse(res);
});

// DELETE /api/me/bff-sessions/:sessionId — 自分の特定BFFセッションを失効（self-service）
//
// セキュリティ:
//  - 現在の Cookie セッション ID と一致する場合のみ自身の Cookie を削除（自端末ログアウト動線）
//  - 他端末セッションの失効時は Cookie を保持（操作中ブラウザの利便性を維持）
//  - 列挙攻撃対策として「他人の sessionId」と「存在しない sessionId」は同一 404 に畳み込み済（IdP 側）
//  - refresh_token は本ルート対象外。`/api/me/sessions/:id` で別途失効させる必要あり
app.delete("/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!UUID_RE.test(sessionId)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid session ID format" } }, 400);
  }

  // 現在の Cookie セッションを事前に取得（IdP 失効後に Cookie 削除判定に使う）
  const currentSession = await parseSession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET);

  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/bff-sessions/${sessionId}`,
    {
      method: "DELETE",
      headers: { Origin: c.env.IDP_ORIGIN },
    },
  );

  if (res.status === 204) {
    // 自分の Cookie セッションを失効させた場合のみ Cookie 削除
    if (currentSession && currentSession.session_id === sessionId) {
      deleteCookie(c, SESSION_COOKIE, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      });
    }
    return c.body(null, 204);
  }
  return proxyResponse(res);
});

export default app;
