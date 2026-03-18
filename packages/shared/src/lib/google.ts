const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

export interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  picture?: string;
}

export interface GoogleTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token?: string;
  refresh_token?: string;
}

/**
 * Google認可URLを生成する（state + PKCE S256必須）
 */
export function buildGoogleAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', params.scope ?? 'openid email profile');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'online');
  return url.toString();
}

/**
 * Googleトークンエンドポイントを呼び出してアクセストークンを取得する
 */
export async function exchangeGoogleCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<GoogleTokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: params.codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google token exchange failed: ${error}`);
  }

  return response.json() as Promise<GoogleTokenResponse>;
}

/**
 * GoogleユーザーInfo APIを呼び出してユーザー情報を取得する
 */
export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Google userinfo fetch failed: ${response.status}`);
  }

  return response.json() as Promise<GoogleUserInfo>;
}

/**
 * redirect_uriを正規化する（セキュリティ検証用）
 * - https必須（localhost例外）
 * - fragment禁止
 * - 既定ポート除去（443, 80）
 * - host小文字化
 */
export function normalizeRedirectUri(uri: string): string | null {
  try {
    const url = new URL(uri);

    // fragment禁止
    if (url.hash) return null;

    const isLocalhost =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1';

    // https必須（localhost例外）
    if (!isLocalhost && url.protocol !== 'https:') return null;

    // host小文字化
    url.hostname = url.hostname.toLowerCase();

    // 既定ポート除去
    if (
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80')
    ) {
      url.port = '';
    }

    return url.toString();
  } catch {
    return null;
  }
}
