import { fetchWithRetry } from './fetch-retry';

const TWITCH_AUTH_URL = 'https://id.twitch.tv/oauth2/authorize';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_USERINFO_URL = 'https://id.twitch.tv/oauth2/userinfo';

export interface TwitchUserInfo {
  sub: string;
  preferred_username: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
}

export interface TwitchTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token?: string;
  scope: string[];
}

/**
 * Twitch認可URLを生成する（state + PKCE S256必須）
 */
export function buildTwitchAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  nonce?: string;
}): string {
  const url = new URL(TWITCH_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', 'openid user:read:email');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (params.nonce) {
    url.searchParams.set('nonce', params.nonce);
  }
  return url.toString();
}

/**
 * Twitchトークンエンドポイントを呼び出してアクセストークンを取得する
 * 一時障害・429に対して最大3回リトライ（指数バックオフ）
 */
export async function exchangeTwitchCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TwitchTokenResponse> {
  const response = await fetchWithRetry(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code_verifier: params.codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Twitch token exchange failed: ${error}`);
  }

  try {
    return (await response.json()) as TwitchTokenResponse;
  } catch {
    throw new Error('Twitch token exchange failed: Invalid JSON response');
  }
}

/**
 * Twitch OIDC UserInfo APIを呼び出してユーザー情報を取得する
 */
export async function fetchTwitchUserInfo(accessToken: string): Promise<TwitchUserInfo> {
  const response = await fetchWithRetry(TWITCH_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Twitch userinfo fetch failed: ${response.status}`);
  }

  try {
    return (await response.json()) as TwitchUserInfo;
  } catch {
    throw new Error('Twitch userinfo fetch failed: Invalid JSON response');
  }
}
