import { sha256, findRefreshTokenByHash, findUserById, createLogger } from "@0g0-id/shared";
import { parseAllowedScopes } from "../../utils/scopes";
import { buildTokenResponse } from "../../utils/token-pair";
import { attemptUnrevokeToken } from "../../utils/token-recovery";
import {
  validateAndRevokeRefreshToken,
  issueTokenPairWithRecovery,
} from "../../utils/refresh-token-rotation";
import { type TokenHandlerContext, resolveOAuthClient } from "./utils";

const tokenLogger = createLogger("token");

/**
 * refresh_token グラント処理
 */
export async function handleRefreshTokenGrant(
  c: TokenHandlerContext,
  params: Record<string, string>,
): Promise<Response> {
  const refreshTokenRaw = params["refresh_token"];
  const clientId = params["client_id"];

  if (!refreshTokenRaw) {
    return c.json(
      { error: "invalid_request", error_description: "refresh_token is required" },
      400,
    );
  }

  // クライアント認証
  const clientResult = await resolveOAuthClient(c.env.DB, c.req.header("Authorization"), clientId);
  if (!clientResult.ok) {
    if (clientResult.status === 401 && clientResult.error === "invalid_client") {
      c.header("WWW-Authenticate", 'Basic realm="0g0-id"');
    }
    return c.json({ error: clientResult.error }, clientResult.status);
  }
  const service = clientResult.service;

  const tokenHash = await sha256(refreshTokenRaw);

  const validationResult = await validateAndRevokeRefreshToken(c.env.DB, tokenHash);
  if (!validationResult.ok) {
    if (validationResult.reason === "TOKEN_ROTATED") {
      return c.json(
        { error: "invalid_grant", error_description: "Token rotation in progress, please retry" },
        400,
      );
    }
    if (validationResult.reason === "TOKEN_REUSE") {
      return c.json({ error: "invalid_grant", error_description: "Token reuse detected" }, 400);
    }
    return c.json({ error: "invalid_grant", error_description: "Invalid refresh token" }, 400);
  }
  const storedToken = validationResult.storedToken;

  // サービス所有権確認 & 有効期限チェック（D1クエリを1回に統合）
  const serviceMismatch = storedToken.service_id !== service.id;
  const isExpired = new Date(storedToken.expires_at) < new Date();

  if (serviceMismatch || isExpired) {
    // 並行リクエストが reuse_detected を発動した可能性をチェック（レース条件対策）
    const currentToken = await findRefreshTokenByHash(c.env.DB, tokenHash);
    if (currentToken && currentToken.revoked_reason === "reuse_detected") {
      return c.json({ error: "invalid_grant", error_description: "Token reuse detected" }, 400);
    }
    // 期限切れトークン: rotation済み状態のまま拒否（unrevokeは不要かつ危険）
    if (isExpired) {
      return c.json({ error: "invalid_grant", error_description: "Refresh token expired" }, 400);
    }
    if (serviceMismatch) {
      // 別サービス向けのトークン → 元に戻して拒否
      await attemptUnrevokeToken(c.env.DB, storedToken.id, "[token] service_id mismatch 後");
      return c.json(
        { error: "invalid_grant", error_description: "Token was not issued for this client" },
        400,
      );
    }
  }

  // ユーザー情報取得
  const user = await findUserById(c.env.DB, storedToken.user_id);
  if (!user) {
    return c.json({ error: "invalid_grant", error_description: "User not found" }, 400);
  }
  if (user.banned_at !== null) {
    return c.json({ error: "access_denied", error_description: "Account has been suspended" }, 403);
  }

  // スコープ引き継ぎ
  const refreshScope =
    storedToken.scope ?? (parseAllowedScopes(service.allowed_scopes).join(" ") || "openid");

  const issueResult = await issueTokenPairWithRecovery(
    c.env.DB,
    c.env,
    user,
    {
      serviceId: service.id,
      clientId: service.client_id,
      familyId: storedToken.family_id,
      scope: refreshScope,
    },
    storedToken.id,
    tokenHash,
    tokenLogger,
    "handleRefreshTokenGrant",
  );
  if (!issueResult.ok) {
    if (issueResult.reason === "TOKEN_REUSE") {
      return c.json({ error: "invalid_grant", error_description: "Token reuse detected" }, 400);
    }
    return c.json({ error: "server_error", error_description: "Token operation failed" }, 500);
  }
  const accessToken = issueResult.accessToken;
  const newRefreshToken = issueResult.refreshToken;

  // レスポンス (RFC 6749 §5.1)
  return c.json(buildTokenResponse(accessToken, newRefreshToken, refreshScope));
}
