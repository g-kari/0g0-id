import type { Context } from "hono";
import type { IdpEnv, Service, TokenPayload } from "@0g0-id/shared";
import {
  sha256,
  findRefreshTokenByHash,
  revokeRefreshToken,
  verifyAccessToken,
  addRevokedAccessToken,
  createLogger,
} from "@0g0-id/shared";
import { authenticateService } from "../../utils/service-auth";
import { parseTokenBody } from "./utils";

const tokenLogger = createLogger("token");

/**
 * POST /api/token/revoke — RFC 7009 トークン失効
 */
export async function handleRevoke(c: Context<{ Bindings: IdpEnv }>) {
  // Basic認証でサービス認証
  let service: Service | null;
  try {
    service = await authenticateService(c.env.DB, c.req.header("Authorization"));
  } catch (err) {
    tokenLogger.error("Revoke: service authentication failed", err);
    return c.json({ error: "server_error" }, 500);
  }
  if (!service) {
    c.header("WWW-Authenticate", 'Basic realm="0g0-id"');
    return c.json({ error: "invalid_client" }, 401);
  }

  // トークン取得（RFC 7009: application/x-www-form-urlencoded および application/json に対応）
  const body = await parseTokenBody(c.req);
  if (!body) {
    return c.json({ error: "invalid_request" }, 400);
  }

  if (!body.token) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const token = body.token;

  // JWTアクセストークンの失効処理（RFC 7009 §2.1）
  const JWT_PATTERN = /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/;
  if (JWT_PATTERN.test(token)) {
    let payload: TokenPayload | null = null;
    try {
      payload = await verifyAccessToken(
        token,
        c.env.JWT_PUBLIC_KEY,
        c.env.IDP_ORIGIN,
        c.env.IDP_ORIGIN,
      );
    } catch {
      // JWT検証失敗 → リフレッシュトークン処理へフォールスルー
    }
    if (payload !== null) {
      if (
        payload.jti &&
        payload.cid &&
        payload.cid === service.client_id &&
        payload.exp &&
        payload.exp > Math.floor(Date.now() / 1000)
      ) {
        try {
          await addRevokedAccessToken(c.env.DB, payload.jti, payload.exp);
        } catch (err) {
          tokenLogger.error("Revoke: failed to add revoked access token to blocklist", err);
          return c.json({ error: "server_error" }, 500);
        }
      }
      return new Response(null, { status: 200 });
    }
  }

  // リフレッシュトークンの失効処理
  const tokenHash = await sha256(token);
  try {
    const refreshToken = await findRefreshTokenByHash(c.env.DB, tokenHash);

    // RFC 7009: トークンが存在しない・失効済みでも 200 OK を返す（情報漏洩防止）
    if (
      refreshToken &&
      refreshToken.revoked_at === null &&
      refreshToken.service_id === service.id
    ) {
      await revokeRefreshToken(c.env.DB, refreshToken.id, "service_revoke");
    }
  } catch (err) {
    tokenLogger.error("Revoke: failed to process refresh token", err);
    return c.json({ error: "server_error" }, 500);
  }

  return new Response(null, { status: 200 });
}
