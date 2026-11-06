import {
  sha256,
  findAndConsumeAuthCode,
  findUserById,
  findResourceServerByUri,
  generateCodeChallenge,
  timingSafeEqual,
  normalizeRedirectUri,
  matchRedirectUri,
  createLogger,
} from "@0g0-id/shared";
import {
  resolveEffectiveScope,
  resolveResourceScope,
  isSubjectAllowedForResource,
} from "../../utils/scopes";
import {
  issueTokenPair,
  buildTokenResponse,
  issueIdToken,
  ResourceRegistrationGoneError,
} from "../../utils/token-pair";
import { type TokenHandlerContext, resolveOAuthClient } from "./utils";

const tokenLogger = createLogger("token");

/**
 * authorization_code グラント処理
 */
export async function handleAuthorizationCodeGrant(
  c: TokenHandlerContext,
  params: Record<string, string>,
): Promise<Response> {
  const code = params["code"];
  const redirectUri = params["redirect_uri"];
  const clientId = params["client_id"];
  const codeVerifier = params["code_verifier"];

  if (!code) {
    return c.json({ error: "invalid_request", error_description: "code is required" }, 400);
  }
  if (!redirectUri) {
    return c.json({ error: "invalid_request", error_description: "redirect_uri is required" }, 400);
  }
  // クライアント認証
  const clientResult = await resolveOAuthClient(c.env.DB, c.req.header("Authorization"), clientId);
  if (!clientResult.ok) {
    if (clientResult.status === 401 && clientResult.error === "invalid_client") {
      c.header("WWW-Authenticate", 'Basic realm="0g0-id"');
    }
    return c.json({ error: clientResult.error }, clientResult.status);
  }
  const { service, isPublicClient } = clientResult;

  // 認可コード検証
  const codeHash = await sha256(code);
  const authCode = await findAndConsumeAuthCode(c.env.DB, codeHash);
  if (!authCode) {
    return c.json(
      { error: "invalid_grant", error_description: "Invalid or expired authorization code" },
      400,
    );
  }

  // service_id の一致確認
  if (authCode.service_id !== service.id) {
    return c.json(
      {
        error: "invalid_grant",
        error_description: "Authorization code was not issued for this client",
      },
      400,
    );
  }

  // redirect_uri を正規化してから比較（RFC 6749 §4.1.3）
  const normalizedRedirectUri = normalizeRedirectUri(redirectUri);
  if (!normalizedRedirectUri || !matchRedirectUri(authCode.redirect_to, normalizedRedirectUri)) {
    return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
  }

  // パブリッククライアントはPKCEを必須とする（RFC 7636 §4.4 / OAuth 2.1）
  if (isPublicClient && !authCode.code_challenge) {
    return c.json(
      { error: "invalid_grant", error_description: "PKCE is required for public clients" },
      400,
    );
  }

  // PKCE 検証 (S256)
  if (authCode.code_challenge) {
    if (!codeVerifier) {
      return c.json(
        { error: "invalid_request", error_description: "code_verifier is required" },
        400,
      );
    }
    if (codeVerifier.length < 43 || codeVerifier.length > 128) {
      return c.json(
        { error: "invalid_request", error_description: "code_verifier must be 43-128 characters" },
        400,
      );
    }
    if (!/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) {
      return c.json(
        {
          error: "invalid_request",
          error_description: "code_verifier contains invalid characters",
        },
        400,
      );
    }
    const expectedChallenge = await generateCodeChallenge(codeVerifier);
    if (!timingSafeEqual(expectedChallenge, authCode.code_challenge)) {
      return c.json({ error: "invalid_grant", error_description: "code_verifier mismatch" }, 400);
    }
  }

  try {
    // ユーザー情報取得
    const user = await findUserById(c.env.DB, authCode.user_id);
    if (!user || user.banned_at !== null) {
      return c.json(
        { error: "invalid_grant", error_description: "Invalid or expired authorization code" },
        400,
      );
    }

    // RFC 8707: 認可コードに resource が束縛されている場合はリソース束縛
    // トークンを発行する。トークンリクエスト側の resource は、指定されたら
    // コード側と完全一致しなければならない。
    const requestedResource = params["resource"];
    if (authCode.resource) {
      if (requestedResource !== undefined && requestedResource !== authCode.resource) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "resource does not match the authorization request",
          },
          400,
        );
      }
      const resourceServer = await findResourceServerByUri(c.env.DB, authCode.resource);
      if (!resourceServer) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "resource is no longer a registered resource server",
          },
          400,
        );
      }
      // 登録世代の照合: コード発行時の resource_servers 行 id と現在の
      // 行 id が異なれば、削除→同 URI 再登録を経ている。URI が一致しても
      // 削除前のコードから新しい登録向けのトークンを発行しない
      // （削除時点を失効境界にする）。
      // 世代が記録されていない旧形式コード（resource あり・世代なし）も
      // 照合できないため安全側で拒否する。コードの有効期間は60秒のため、
      // 移行時に失効するのは最大で60秒分の未交換コードに限られる。
      if (authCode.resource_server_id !== resourceServer.id) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "resource registration that issued this code no longer exists",
          },
          400,
        );
      }
      // 利用者制限（allowed_subjects）が設定されているリソースでは、
      // 許可された subject 以外には発行しない（登録＝全員許可にしない）
      if (!isSubjectAllowedForResource(resourceServer, user.id)) {
        return c.json(
          {
            error: "invalid_grant",
            error_description: "subject is not allowed to use this resource",
          },
          400,
        );
      }
      // スコープはリソースサーバー側の登録スコープが上限
      const resourceScope = resolveResourceScope(authCode.scope, resourceServer.allowed_scopes);
      if (resourceScope === undefined) {
        return c.json({ error: "invalid_scope", error_description: "No valid scope" }, 400);
      }
      const { accessToken, refreshToken } = await issueTokenPair(c.env.DB, c.env, user, {
        serviceId: service.id,
        clientId: service.client_id,
        scope: resourceScope,
        resource: authCode.resource,
        // 発行は検証した登録世代への束縛で行う（削除競合時は gone エラー）
        resourceServerId: resourceServer.id,
      });
      const idToken = await issueIdToken(c.env, user, service, resourceScope, {
        nonce: authCode.nonce ?? undefined,
        amr: authCode.provider ? [authCode.provider] : undefined,
      });
      return c.json(buildTokenResponse(accessToken, refreshToken, resourceScope, idToken));
    }

    // スコープ計算
    const serviceScope = resolveEffectiveScope(authCode.scope, service.allowed_scopes);
    if (serviceScope === undefined) {
      return c.json({ error: "invalid_scope", error_description: "No valid scope" }, 400);
    }

    // トークン発行
    const { accessToken, refreshToken } = await issueTokenPair(c.env.DB, c.env, user, {
      serviceId: service.id,
      clientId: service.client_id,
      scope: serviceScope,
    });

    // OIDC ID トークン発行（openid スコープがある場合）
    const idToken = await issueIdToken(c.env, user, service, serviceScope, {
      nonce: authCode.nonce ?? undefined,
      amr: authCode.provider ? [authCode.provider] : undefined,
    });

    // レスポンス (RFC 6749 §5.1)
    return c.json(buildTokenResponse(accessToken, refreshToken, serviceScope, idToken));
  } catch (e) {
    if (e instanceof ResourceRegistrationGoneError) {
      // 検証通過から発行までの間に resource 登録が削除された
      return c.json(
        {
          error: "invalid_grant",
          error_description: "resource is no longer a registered resource server",
        },
        400,
      );
    }
    tokenLogger.error("handleAuthorizationCodeGrant: unexpected error", e);
    return c.json(
      { error: "server_error", error_description: "An unexpected error occurred" },
      500,
    );
  }
}
