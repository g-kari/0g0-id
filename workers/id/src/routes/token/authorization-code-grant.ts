import {
  sha256,
  findAndConsumeAuthCode,
  findUserById,
  generateCodeChallenge,
  timingSafeEqual,
  normalizeRedirectUri,
  matchRedirectUri,
  createLogger,
} from "@0g0-id/shared";
import { resolveEffectiveScope } from "../../utils/scopes";
import { issueTokenPair, buildTokenResponse, issueIdToken } from "../../utils/token-pair";
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
    tokenLogger.error("handleAuthorizationCodeGrant: unexpected error", e);
    return c.json(
      { error: "server_error", error_description: "An unexpected error occurred" },
      500,
    );
  }
}
