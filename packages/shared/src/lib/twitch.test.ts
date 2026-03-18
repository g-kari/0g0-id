import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildTwitchAuthUrl, exchangeTwitchCode, fetchTwitchUserInfo } from './twitch';

describe('buildTwitchAuthUrl', () => {
  it('正しいTwitch認可URLを生成する', () => {
    const url = buildTwitchAuthUrl({
      clientId: 'test-client-id',
      redirectUri: 'https://example.com/callback',
      state: 'test-state',
      codeChallenge: 'test-challenge',
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://id.twitch.tv');
    expect(parsed.pathname).toBe('/oauth2/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    expect(parsed.searchParams.get('state')).toBe('test-state');
    expect(parsed.searchParams.get('code_challenge')).toBe('test-challenge');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toContain('openid');
  });
});

describe('exchangeTwitchCode', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseParams = {
    code: 'auth-code',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/callback',
    codeVerifier: 'verifier',
  };

  it('正常時にトークンレスポンスを返す', async () => {
    const tokenResponse = {
      access_token: 'twitch-access-token',
      token_type: 'bearer',
      expires_in: 3600,
      scope: ['openid', 'user:read:email'],
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    );
    const result = await exchangeTwitchCode(baseParams);
    expect(result.access_token).toBe('twitch-access-token');
  });

  it('HTTPエラー時に例外を投げる', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('error body', { status: 400 }));
    await expect(exchangeTwitchCode(baseParams)).rejects.toThrow('Twitch token exchange failed');
  });

  it('不正なJSONレスポンス時に明示的なエラーを投げる', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    await expect(exchangeTwitchCode(baseParams)).rejects.toThrow(
      'Twitch token exchange failed: Invalid JSON response'
    );
  });
});

describe('fetchTwitchUserInfo', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('正常時にユーザー情報を返す', async () => {
    const userInfo = {
      sub: 'twitch-user-123',
      preferred_username: 'teststreamer',
      email: 'streamer@example.com',
      email_verified: true,
      picture: 'https://static-cdn.jtvnw.net/test.jpg',
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(userInfo), { status: 200 })
    );
    const result = await fetchTwitchUserInfo('test-access-token');
    expect(result.sub).toBe('twitch-user-123');
    expect(result.preferred_username).toBe('teststreamer');
    expect(result.email).toBe('streamer@example.com');
    expect(result.email_verified).toBe(true);
  });

  it('HTTPエラー時に例外を投げる', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await expect(fetchTwitchUserInfo('bad-token')).rejects.toThrow(
      'Twitch userinfo fetch failed: 401'
    );
  });

  it('emailなしのユーザー情報も正常に返す', async () => {
    const userInfo = {
      sub: 'twitch-user-456',
      preferred_username: 'noemail',
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(userInfo), { status: 200 })
    );
    const result = await fetchTwitchUserInfo('test-access-token');
    expect(result.sub).toBe('twitch-user-456');
    expect(result.email).toBeUndefined();
  });
});
