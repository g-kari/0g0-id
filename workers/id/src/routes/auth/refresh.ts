import type { Context } from "hono";
import { z } from "zod";
import type { IdpEnv, Service, TokenPayload } from "@0g0-id/shared";
import { parseJsonBody, sha256, findUserById, findServiceById, createLogger } from "@0g0-id/shared";
import { resolveEffectiveScope } from "../../utils/scopes";
import { ACCESS_TOKEN_TTL_SECONDS } from "../../utils/token-pair";
import {
  validateAndRevokeRefreshToken,
  issueTokenPairWithRecovery,
} from "../../utils/refresh-token-rotation";

const authLogger = createLogger("auth");

const RefreshSchema = z.object({
  refresh_token: z.string().min(1, "refresh_token is required"),
});

type Variables = { user: TokenPayload };

/**
 * POST /auth/refresh — トークンリフレッシュ（BFFサーバー間専用）
 */
export async function handleRefresh(c: Context<{ Bindings: IdpEnv; Variables: Variables }>) {
  const result = await parseJsonBody(c, RefreshSchema);
  if (!result.ok) return result.response;

  const tokenHash = await sha256(result.data.refresh_token);

  const validationResult = await validateAndRevokeRefreshToken(c.env.DB, tokenHash);
  if (!validationResult.ok) {
    if (validationResult.reason === "TOKEN_ROTATED") {
      return c.json(
        {
          error: { code: "TOKEN_ROTATED", message: "Token already rotated, retry with new token" },
        },
        401,
      );
    }
    if (validationResult.reason === "TOKEN_REUSE") {
      return c.json({ error: { code: "TOKEN_REUSE", message: "Token reuse detected" } }, 401);
    }
    return c.json({ error: { code: "INVALID_TOKEN", message: "Token not found" } }, 401);
  }
  const storedToken = validationResult.storedToken;

  // 有効期限チェック
  if (new Date(storedToken.expires_at) < new Date()) {
    return c.json({ error: { code: "TOKEN_EXPIRED", message: "Refresh token expired" } }, 401);
  }

  // ユーザー情報取得
  const user = await findUserById(c.env.DB, storedToken.user_id);
  if (!user) {
    return c.json({ error: { code: "INVALID_GRANT", message: "User not found" } }, 401);
  }

  // BANされたユーザーのトークン更新を拒否
  if (user.banned_at !== null) {
    return c.json(
      { error: { code: "ACCOUNT_BANNED", message: "Your account has been suspended" } },
      403,
    );
  }

  // サービストークンの場合: 元のサービスのスコープを引き継ぐ
  let refreshScope: string | undefined = undefined;
  let refreshService: Service | null | undefined = undefined;
  if (storedToken.service_id !== null) {
    refreshService = await findServiceById(c.env.DB, storedToken.service_id);
    if (!refreshService) {
      // サービス削除済み → トークンリフレッシュを拒否
      return c.json({ error: { code: "INVALID_TOKEN", message: "Service no longer exists" } }, 401);
    }
    // 保存済みスコープがあればそれを引き継ぐ（スコープ昇格防止）
    // 保存済みスコープがない（マイグレーション前のトークン）場合はallowed_scopesにフォールバック
    refreshScope = storedToken.scope ?? resolveEffectiveScope(null, refreshService.allowed_scopes);
  }

  const issueResult = await issueTokenPairWithRecovery(
    c.env.DB,
    c.env,
    user,
    {
      serviceId: storedToken.service_id,
      clientId: refreshService?.client_id,
      familyId: storedToken.family_id,
      scope: refreshScope,
    },
    storedToken.id,
    tokenHash,
    authLogger,
    "handleRefresh",
  );
  if (!issueResult.ok) {
    if (issueResult.reason === "TOKEN_REUSE") {
      return c.json({ error: { code: "TOKEN_REUSE", message: "Token reuse detected" } }, 401);
    }
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Token operation failed" } }, 500);
  }
  const accessToken = issueResult.accessToken;
  const newRefreshTokenRaw = issueResult.refreshToken;

  return c.json({
    data: {
      access_token: accessToken,
      refresh_token: newRefreshTokenRaw,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    },
  });
}
