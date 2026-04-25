import type { Context } from "hono";
import type { IdpEnv } from "@0g0-id/shared";
import { createLogger } from "@0g0-id/shared";
import { validateNonce, validateCodeChallengeParams } from "../../utils/scopes";
import { validateServiceRedirectUri } from "../../utils/auth-helpers";

const authLogger = createLogger("auth");

type OAuthErrorCode = "invalid_request" | "unsupported_response_type" | "server_error";

/**
 * RFC 6749 形式の OAuth エラーレスポンスを返すヘルパー。
 * `{ error, error_description }` に固定化し、ステータスコードを指定する。
 */
function oauthError(
  c: Context<{ Bindings: IdpEnv }>,
  error: OAuthErrorCode,
  description: string,
  status: 400 | 500,
) {
  return c.json({ error, error_description: description }, status);
}

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

  // response_type は unsupported_response_type なので個別処理
  if (responseType !== "code") {
    return oauthError(c, "unsupported_response_type", "Only response_type=code is supported", 400);
  }

  // 必須パラメータ検証（table 駆動）
  const requiredChecks: { value: string | undefined; msg: string }[] = [
    { value: clientId, msg: "client_id is required" },
    { value: redirectUri, msg: "redirect_uri is required" },
    { value: state, msg: "state is required" },
    { value: codeChallenge, msg: "code_challenge is required (PKCE S256)" },
  ];
  for (const check of requiredChecks) {
    if (!check.value) {
      return oauthError(c, "invalid_request", check.msg, 400);
    }
  }
  // 型ナローイング: 上記 for ループで undefined を排除
  if (!clientId || !redirectUri || !state || !codeChallenge) {
    return oauthError(c, "invalid_request", "missing required parameter", 400);
  }

  const codeChallengeError = validateCodeChallengeParams(codeChallenge, codeChallengeMethod);
  if (codeChallengeError) {
    return oauthError(c, "invalid_request", codeChallengeError, 400);
  }

  // パラメータ長制限（table 駆動）
  const lengthChecks: { value: string | undefined; max: number; msg: string }[] = [
    { value: redirectUri, max: 2048, msg: "redirect_uri too long" },
    { value: state, max: 1024, msg: "state too long" },
    { value: scope, max: 2048, msg: "scope too long" },
  ];
  for (const check of lengthChecks) {
    if (check.value && check.value.length > check.max) {
      return oauthError(c, "invalid_request", check.msg, 400);
    }
  }
  // nonce はOIDCオプション。長さ + 制御文字を検証（OIDC Core 1.0 §3.1.2.1）
  const nonceError = validateNonce(nonce);
  if (nonceError) {
    return oauthError(c, "invalid_request", nonceError, 400);
  }

  let uriResult: Awaited<ReturnType<typeof validateServiceRedirectUri>>;
  try {
    uriResult = await validateServiceRedirectUri(c.env.DB, clientId, redirectUri);
  } catch (err) {
    authLogger.error("[authorize] Failed to validate service redirect URI", err);
    return oauthError(c, "server_error", "Internal server error", 500);
  }
  if (!uriResult.ok) {
    return oauthError(c, "invalid_request", uriResult.error, 400);
  }

  // ユーザーをプロバイダー選択画面（USER_ORIGIN/login）にリダイレクト
  // BFFのログイン画面がプロバイダー選択とIdPへの/auth/loginリダイレクトを担当する
  const loginUrl = new URL("/login", c.env.USER_ORIGIN);
  loginUrl.searchParams.set("service_id", uriResult.serviceId);
  loginUrl.searchParams.set("client_id", clientId);
  loginUrl.searchParams.set("redirect_uri", redirectUri);
  loginUrl.searchParams.set("state", state);
  loginUrl.searchParams.set("code_challenge", codeChallenge);
  loginUrl.searchParams.set("code_challenge_method", codeChallengeMethod ?? "S256");
  if (scope) {
    loginUrl.searchParams.set("scope", scope);
  }
  // OIDC: nonce を転送（ID Token に埋め込むため USER_ORIGIN/login → IdP /auth/login → auth code → token発行まで引き継ぐ）
  if (nonce) {
    loginUrl.searchParams.set("nonce", nonce);
  }

  return c.redirect(loginUrl.toString());
}
