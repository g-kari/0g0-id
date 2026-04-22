import { fetchWithRetry } from "./fetch-retry";
import { createLogger } from "./logger";

const logger = createLogger("oauth-line");

const LINE_AUTH_URL = "https://access.line.me/oauth2/v2.1/authorize";
const LINE_TOKEN_URL = "https://api.line.me/oauth2/v2.1/token";
const LINE_USERINFO_URL = "https://api.line.me/oauth2/v2.1/userinfo";

export interface LineUserInfo {
  sub: string;
  name: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
}

export interface LineTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token?: string;
  scope: string;
}

/**
 * LINE認可URLを生成する（state + PKCE S256必須）
 */
export function buildLineAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  nonce?: string;
}): string {
  const url = new URL(LINE_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.nonce) {
    url.searchParams.set("nonce", params.nonce);
  }
  return url.toString();
}

/**
 * LINEトークンエンドポイントを呼び出してアクセストークンを取得する
 * 一時障害・429に対して最大3回リトライ（指数バックオフ）
 */
export async function exchangeLineCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<LineTokenResponse> {
  const response = await fetchWithRetry(LINE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code_verifier: params.codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    logger.error(`LINE token exchange failed (${response.status})`, error);
    throw new Error("LINE token exchange failed");
  }

  try {
    return (await response.json()) as LineTokenResponse;
  } catch {
    throw new Error("LINE token exchange failed: Invalid JSON response");
  }
}

/**
 * LINE UserInfo APIを呼び出してユーザー情報を取得する
 */
export async function fetchLineUserInfo(accessToken: string): Promise<LineUserInfo> {
  const response = await fetchWithRetry(LINE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`LINE userinfo fetch failed: ${response.status}`);
  }

  try {
    return (await response.json()) as LineUserInfo;
  } catch {
    throw new Error("LINE userinfo fetch failed: Invalid JSON response");
  }
}
