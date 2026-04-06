import { fetchWithRetry } from './fetch-retry';
import { createLogger } from './logger';

const logger = createLogger('oauth-x');

const X_AUTH_URL = 'https://twitter.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
const X_USER_URL = 'https://api.twitter.com/2/users/me';

export interface XUserInfo {
  id: string;
  name: string | null;
  username: string;
  profile_image_url?: string;
}

export interface XUserResponse {
  data: XUserInfo;
}

export interface XTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope: string;
  refresh_token?: string;
}

/**
 * X (Twitter) OAuth 2.0認可URLを生成する（PKCE必須）
 */
export function buildXAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(X_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', 'tweet.read users.read offline.access');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * X OAuth 2.0トークンエンドポイントでアクセストークンを取得する
 */
export async function exchangeXCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<XTokenResponse> {
  // X OAuth 2.0はBasic認証またはclient_idのみを使用
  const credentials = btoa(`${params.clientId}:${params.clientSecret}`);

  const response = await fetchWithRetry(X_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    logger.error(`X token exchange failed (${response.status})`, error);
    throw new Error('X token exchange failed');
  }

  try {
    return (await response.json()) as XTokenResponse;
  } catch {
    throw new Error('X token exchange failed: Invalid JSON response');
  }
}

/**
 * X User APIを呼び出してユーザー情報を取得する
 */
export async function fetchXUserInfo(accessToken: string): Promise<XUserInfo> {
  const response = await fetchWithRetry(
    `${X_USER_URL}?user.fields=id,name,username,profile_image_url`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`X user info fetch failed: ${response.status}`);
  }

  try {
    const data = (await response.json()) as XUserResponse;
    return data.data;
  } catch {
    throw new Error('X user info fetch failed: Invalid JSON response');
  }
}
