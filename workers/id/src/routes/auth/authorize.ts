import type { Context } from "hono";
import type { IdpEnv, Service, ServiceRedirectUri } from "@0g0-id/shared";
import {
  findServiceByClientId,
  normalizeRedirectUri,
  listRedirectUris,
  matchRedirectUri,
  createLogger,
} from "@0g0-id/shared";
import { validateNonce, validateCodeChallenge } from "../../utils/scopes";

const authLogger = createLogger("auth");

/**
 * GET /auth/authorize — 標準 OAuth 2.0 Authorization エンドポイント (RFC 6749 / RFC 7636 / RFC 8252)
 * MCPクライアント等のネイティブアプリが直接HTTPリクエストで利用する
 */
export async function handleAuthorize(c: Context<{ Bindings: IdpEnv }>) {
  const responseType = c.req.query("response_type");
  const clientId = c.req.query("client_id");
  const redirectUri = c.req.query("redirect_uri");
  const scope = c.req.query("scope");
  const state = c.req.query("state");
  const codeChallenge = c.req.query("code_challenge");
  const codeChallengeMethod = c.req.query("code_challenge_method");
  // OIDC: nonce は任意パラメータ（ID Token にリプレイ攻撃対策として埋め込む）
  const nonce = c.req.query("nonce");

  // 必須パラメータ検証
  if (responseType !== "code") {
    return c.json(
      {
        error: "unsupported_response_type",
        error_description: "Only response_type=code is supported",
      },
      400,
    );
  }
  if (!clientId) {
    return c.json({ error: "invalid_request", error_description: "client_id is required" }, 400);
  }
  if (!redirectUri) {
    return c.json({ error: "invalid_request", error_description: "redirect_uri is required" }, 400);
  }
  if (!state) {
    return c.json({ error: "invalid_request", error_description: "state is required" }, 400);
  }
  if (!codeChallenge) {
    return c.json(
      { error: "invalid_request", error_description: "code_challenge is required (PKCE S256)" },
      400,
    );
  }
  if (codeChallengeMethod !== "S256") {
    return c.json(
      {
        error: "invalid_request",
        error_description: "Only code_challenge_method=S256 is supported",
      },
      400,
    );
  }
  // RFC 7636 §4.2: S256のcode_challengeはBASE64URL(SHA256(code_verifier)) = 43文字
  const codeChallengeError = validateCodeChallenge(codeChallenge);
  if (codeChallengeError) {
    return c.json({ error: "invalid_request", error_description: codeChallengeError }, 400);
  }

  // パラメータ長制限
  if (redirectUri.length > 2048) {
    return c.json({ error: "invalid_request", error_description: "redirect_uri too long" }, 400);
  }
  if (state.length > 1024) {
    return c.json({ error: "invalid_request", error_description: "state too long" }, 400);
  }
  if (scope && scope.length > 2048) {
    return c.json({ error: "invalid_request", error_description: "scope too long" }, 400);
  }
  // nonce はOIDCオプション。長さ + 制御文字を検証（OIDC Core 1.0 §3.1.2.1）
  const nonceError = validateNonce(nonce);
  if (nonceError) {
    return c.json({ error: "invalid_request", error_description: nonceError }, 400);
  }

  // サービス検証
  let service: Service | null;
  try {
    service = await findServiceByClientId(c.env.DB, clientId);
  } catch (err) {
    authLogger.error("[authorize] Failed to find service by client_id", err);
    return c.json({ error: "server_error", error_description: "Internal server error" }, 500);
  }
  if (!service) {
    return c.json({ error: "invalid_request", error_description: "Unknown client_id" }, 400);
  }

  // redirect_uri 検証（localhost/127.0.0.1 の場合はポートを無視: RFC 8252 §7.3）
  const normalizedRequested = normalizeRedirectUri(redirectUri);
  if (!normalizedRequested) {
    return c.json({ error: "invalid_request", error_description: "Invalid redirect_uri" }, 400);
  }

  // 登録済みredirect_uriを取得して、matchRedirectUriで比較
  let registeredUris: ServiceRedirectUri[];
  try {
    registeredUris = await listRedirectUris(c.env.DB, service.id);
  } catch (err) {
    authLogger.error("[authorize] Failed to list redirect URIs", err);
    return c.json({ error: "server_error", error_description: "Internal server error" }, 500);
  }
  const matched = registeredUris.some((ru) => matchRedirectUri(ru.uri, normalizedRequested));
  if (!matched) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "redirect_uri not registered for this client",
      },
      400,
    );
  }

  // ユーザーをプロバイダー選択画面（USER_ORIGIN/login）にリダイレクト
  // BFFのログイン画面がプロバイダー選択とIdPへの/auth/loginリダイレクトを担当する
  const loginUrl = new URL("/login", c.env.USER_ORIGIN);
  loginUrl.searchParams.set("service_id", service.id);
  loginUrl.searchParams.set("client_id", clientId);
  loginUrl.searchParams.set("redirect_uri", redirectUri);
  loginUrl.searchParams.set("state", state);
  loginUrl.searchParams.set("code_challenge", codeChallenge);
  loginUrl.searchParams.set("code_challenge_method", codeChallengeMethod);
  if (scope) {
    loginUrl.searchParams.set("scope", scope);
  }
  // OIDC: nonce を転送（ID Token に埋め込むため USER_ORIGIN/login → IdP /auth/login → auth code → token発行まで引き継ぐ）
  if (nonce) {
    loginUrl.searchParams.set("nonce", nonce);
  }

  return c.redirect(loginUrl.toString());
}
