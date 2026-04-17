import type { Context } from "hono";
import { z } from "zod";
import type { IdpEnv, RefreshToken, TokenPayload } from "@0g0-id/shared";
import {
  parseJsonBody,
  sha256,
  findRefreshTokenByHash,
  revokeRefreshToken,
  verifyAccessToken,
  addRevokedAccessToken,
  createLogger,
  restErrorBody,
  revokeBffSession,
} from "@0g0-id/shared";

const authLogger = createLogger("auth");

const LogoutSchema = z.object({
  refresh_token: z.string().optional(),
  session_id: z.string().uuid().optional(),
});

type Variables = { user: TokenPayload };

/**
 * POST /auth/logout — ログアウト（BFFサーバー間専用）
 */
export async function handleLogout(c: Context<{ Bindings: IdpEnv; Variables: Variables }>) {
  const result = await parseJsonBody(c, LogoutSchema);
  if (!result.ok) return result.response;

  // アクセストークンの失効処理（Authorizationヘッダーから取得）
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const accessToken = authHeader.slice(7);
    try {
      const payload = await verifyAccessToken(
        accessToken,
        c.env.JWT_PUBLIC_KEY,
        c.env.IDP_ORIGIN,
        c.env.IDP_ORIGIN,
      );
      if (payload.jti && payload.exp && payload.exp > Math.floor(Date.now() / 1000)) {
        await addRevokedAccessToken(c.env.DB, payload.jti, payload.exp);
      }
    } catch {
      // JWT検証失敗は無視してログアウトを続行
    }
  }

  const { refresh_token: refreshToken, session_id: bffSessionId } = result.data;

  // BFF セッションの失効（issue #139 対応）。
  // refresh_token 失効と独立して行うことで、Cookie 側 session_id だけでも確実に失効させる。
  if (bffSessionId) {
    try {
      await revokeBffSession(c.env.DB, bffSessionId, "user_logout");
    } catch (err) {
      authLogger.error("[logout] Failed to revoke bff_session", err);
      // bff_session 失効失敗はログアウト全体を失敗扱いにする（Cookie が活きたままになるのを避ける）
      return c.json(restErrorBody("INTERNAL_ERROR", "Failed to revoke session"), 500);
    }
  }

  if (refreshToken) {
    const tokenHash = await sha256(refreshToken);
    let storedToken: RefreshToken | null;
    try {
      storedToken = await findRefreshTokenByHash(c.env.DB, tokenHash);
    } catch (err) {
      authLogger.error("[logout] Failed to find refresh token", err);
      return c.json(restErrorBody("INTERNAL_ERROR", "Failed to process logout"), 500);
    }
    if (storedToken && storedToken.revoked_at === null) {
      try {
        await revokeRefreshToken(c.env.DB, storedToken.id, "user_logout");
      } catch (err) {
        authLogger.error("[logout] Failed to revoke refresh token", err);
        return c.json(restErrorBody("INTERNAL_ERROR", "Failed to revoke token"), 500);
      }
    }
  }

  return c.json({ data: { success: true } });
}
