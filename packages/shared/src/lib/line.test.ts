import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildLineAuthUrl, exchangeLineCode, fetchLineUserInfo } from './line';

describe('buildLineAuthUrl', () => {
  it('正しいLINE認可URLを生成する', () => {
    const url = buildLineAuthUrl({
      clientId: 'test-client-id',
      redirectUri: 'https://example.com/callback',
      state: 'test-state',
      codeChallenge: 'test-challenge',
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://access.line.me');
    expect(parsed.pathname).toBe('/oauth2/v2.1/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    expect(parsed.searchParams.get('state')).toBe('test-state');
    expect(parsed.searchParams.get('code_challenge')).toBe('test-challenge');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toContain('openid');
  });
});

describe('exchangeLineCode', () => {
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
      access_token: 'line-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid profile email',
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    );
    const result = await exchangeLineCode(baseParams);
    expect(result.access_token).toBe('line-access-token');
  });

  it('HTTPエラー時に例外を投げる', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('error body', { status: 400 }));
    await expect(exchangeLineCode(baseParams)).rejects.toThrow('LINE token exchange failed');
  });

  it('不正なJSONレスポンス時に明示的なエラーを投げる', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    await expect(exchangeLineCode(baseParams)).rejects.toThrow(
      'LINE token exchange failed: Invalid JSON response'
    );
  });
});

describe('fetchLineUserInfo', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('正常時にユーザー情報を返す', async () => {
    const userInfo = {
      sub: 'line-user-123',
      name: 'Test User',
      picture: 'https://profile.line-scdn.net/test.jpg',
      email: 'test@example.com',
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(userInfo), { status: 200 })
    );
    const result = await fetchLineUserInfo('test-access-token');
    expect(result.sub).toBe('line-user-123');
    expect(result.name).toBe('Test User');
    expect(result.email).toBe('test@example.com');
  });

  it('HTTPエラー時に例外を投げる', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await expect(fetchLineUserInfo('bad-token')).rejects.toThrow('LINE userinfo fetch failed: 401');
  });

  it('emailなしのユーザー情報も正常に返す', async () => {
    const userInfo = {
      sub: 'line-user-456',
      name: 'No Email User',
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(userInfo), { status: 200 })
    );
    const result = await fetchLineUserInfo('test-access-token');
    expect(result.sub).toBe('line-user-456');
    expect(result.email).toBeUndefined();
  });
});
