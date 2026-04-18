import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { BffEnv } from "@0g0-id/shared";
import {
  parseSession,
  verifyDbscRegistrationJwt,
  internalServiceHeaders,
  createLogger,
} from "@0g0-id/shared";
import { SESSION_COOKIE } from "./auth";

const dbscLogger = createLogger("admin-dbsc");

const app = new Hono<{ Bindings: BffEnv }>();

/**
 * POST /auth/dbsc/start — DBSC 端末公開鍵登録（Chrome 専用フロー）
 *
 * Phase 1 仕様:
 * 1. ブラウザは登録 JWT（ヘッダの jwk に端末公開鍵を含む自署 JWS）を本文に送る。
 * 2. サーバは JWT を検証し、bff_sessions に公開鍵を結びつける（IdP の internal API 経由）。
 * 3. Phase 1 では短寿命 Cookie・チャレンジ・リフレッシュは発行しない（Phase 2 で実装）。
 */
app.post("/start", async (c) => {
  const session = await parseSession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET);
  if (!session) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "No session" } }, 401);
  }

  const contentType = (c.req.header("Content-Type") ?? "").toLowerCase().split(";")[0]?.trim();
  let jwt: string;
  if (contentType === "application/jwt") {
    jwt = (await c.req.text()).trim();
  } else {
    // JSON 形式 ({ jwt: "..." }) も受け付ける（テスト・将来の SDK 互換用）。
    try {
      const body = (await c.req.json()) as { jwt?: unknown };
      if (typeof body.jwt !== "string") {
        return c.json({ error: { code: "INVALID_REQUEST", message: "Missing jwt" } }, 400);
      }
      jwt = body.jwt.trim();
    } catch {
      return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid body" } }, 400);
    }
  }

  if (!jwt) {
    return c.json({ error: { code: "INVALID_REQUEST", message: "Empty jwt" } }, 400);
  }

  let publicJwk;
  try {
    const verified = await verifyDbscRegistrationJwt(jwt, { audience: c.env.SELF_ORIGIN });
    publicJwk = verified.publicJwk;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown";
    dbscLogger.warn("[dbsc-start] JWT verification failed", { reason });
    return c.json({ error: { code: "INVALID_JWT", message: "Invalid registration JWT" } }, 400);
  }

  const bindResp = await c.env.IDP.fetch(
    new Request(`${c.env.IDP_ORIGIN}/auth/dbsc/bind`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // IdP 側で session.bff_origin と一致確認するための呼び出し元宣言。
        "X-BFF-Origin": c.env.SELF_ORIGIN,
        ...internalServiceHeaders(c.env),
      },
      body: JSON.stringify({ session_id: session.session_id, public_jwk: publicJwk }),
    }),
  );

  if (!bindResp.ok) {
    dbscLogger.warn("[dbsc-start] IdP bind failed", { status: bindResp.status });
    // 列挙攻撃ヒント（INVALID_SESSION か ALREADY_BOUND かの区別）を外向きに与えないため、
    // 4xx はすべて INVALID_REQUEST に畳む。5xx のみ運用判断用に区別する。
    if (bindResp.status >= 500) {
      return c.json(
        { error: { code: "INTERNAL_ERROR", message: "Failed to bind device key" } },
        500,
      );
    }
    return c.json({ error: { code: "INVALID_REQUEST", message: "Cannot bind this session" } }, 400);
  }

  // Phase 2 用にプレースホルダ scope/refresh_url を返す。
  // Chrome は応答 JSON を parse して以降のリフレッシュ動線を組み立てる。
  return c.json({
    session_identifier: session.session_id,
    refresh_url: "/auth/dbsc/refresh",
    scope: { include_site: true },
    credentials: [{ type: "cookie", name: "__Host-admin-session" }],
  });
});

export default app;
