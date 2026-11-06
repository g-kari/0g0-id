import {
  sha256,
  findRefreshTokenByHash,
  findUserById,
  findResourceServerByUri,
  createLogger,
} from "@0g0-id/shared";
import { buildTokenResponse } from "../../utils/token-pair";
import { resolveResourceScope, isSubjectAllowedForResource } from "../../utils/scopes";
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
    // 期限切れトークン: serviceMismatch が同時に true でも unrevoke しない。
    // 理由: expired トークンを unrevoke すると無効なトークンが再び有効化され、
    // rotation 済みの旧トークンが復活するセキュリティリスクがある。
    if (isExpired) {
      return c.json({ error: "invalid_grant", error_description: "Refresh token expired" }, 400);
    } else if (serviceMismatch) {
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
  // A service capability is not a user grant. Missing/empty legacy scope stays minimal.
  let refreshScope = storedToken.scope || "openid";

  // RFC 8707: resource 束縛トークンは更新のたびに現在の登録状態で再検証する。
  // 発行時点の保存済み scope / resource を無条件に引き継がない。
  // resourceServerId は再検証で確定した現在の登録世代。後継トークンの
  // 作成はこの世代への束縛（世代ガード付き INSERT）で行う。
  let resourceServerId: string | null = null;
  if (storedToken.resource) {
    // リクエスト側 resource が保存済みと異なる場合は明示拒否する
    // （黙って別 aud のトークンに化けることを防ぐ）。提示トークンは
    // クライアントの誤りで消費されただけなので失効を取り消して返す。
    const requestedResource = params["resource"];
    if (requestedResource !== undefined && requestedResource !== storedToken.resource) {
      await attemptUnrevokeToken(c.env.DB, storedToken.id, "[token] resource mismatch 後");
      return c.json(
        {
          error: "invalid_grant",
          error_description: "resource does not match the granted resource",
        },
        400,
      );
    }
    // resource 登録が削除されていたら新規発行しない
    // （削除時は該当トークンも失効されるが、二重に防御する）
    const resourceServer = await findResourceServerByUri(c.env.DB, storedToken.resource);
    if (!resourceServer) {
      return c.json(
        {
          error: "invalid_grant",
          error_description: "resource is no longer a registered resource server",
        },
        400,
      );
    }
    // 登録世代の照合: 発行時の resource_servers 行 id と現在の行 id が
    // 異なれば、削除→同 URI 再登録を経ている。URI が一致しても旧登録の
    // grant を新しい登録へ引き継がない（旧権限の復活防止）。
    // 移行前トークン（resource_server_id が null）は現在の世代を取り込む。
    if (storedToken.resource_server_id && storedToken.resource_server_id !== resourceServer.id) {
      return c.json(
        {
          error: "invalid_grant",
          error_description: "resource registration that issued this token no longer exists",
        },
        400,
      );
    }
    // 利用者制限（allowed_subjects）を現在の設定で照合する
    if (!isSubjectAllowedForResource(resourceServer, user.id)) {
      return c.json(
        {
          error: "invalid_grant",
          error_description: "subject is not allowed to use this resource",
        },
        400,
      );
    }
    // scope は現在の allowed_scopes を上限として切り詰める。
    // 有効な scope が残らなければ発行しない。
    const narrowedScope = resolveResourceScope(storedToken.scope, resourceServer.allowed_scopes);
    if (narrowedScope === undefined) {
      return c.json(
        { error: "invalid_scope", error_description: "No valid scope for this resource" },
        400,
      );
    }
    refreshScope = narrowedScope;
    resourceServerId = resourceServer.id;
  }

  const issueResult = await issueTokenPairWithRecovery(
    c.env.DB,
    c.env,
    user,
    {
      serviceId: service.id,
      clientId: service.client_id,
      familyId: storedToken.family_id,
      scope: refreshScope,
      // RFC 8707: 発行時の resource 束縛を引き継ぎ、aud を維持する
      resource: storedToken.resource,
      resourceServerId,
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
    if (issueResult.reason === "RESOURCE_GONE") {
      // 再検証の通過後に resource 登録が削除され、世代ガードが後継トークンの
      // 作成を抑止した。削除済み resource の grant として拒否する。
      return c.json(
        {
          error: "invalid_grant",
          error_description: "resource is no longer a registered resource server",
        },
        400,
      );
    }
    return c.json({ error: "server_error", error_description: "Token operation failed" }, 500);
  }
  const accessToken = issueResult.accessToken;
  const newRefreshToken = issueResult.refreshToken;

  // レスポンス (RFC 6749 §5.1)
  return c.json(buildTokenResponse(accessToken, newRefreshToken, refreshScope));
}
