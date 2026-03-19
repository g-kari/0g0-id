import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildXAuthUrl, exchangeXCode, fetchXUserInfo } from './x';

describe('buildXAuthUrl', () => {
  it('正しいX（Twitter）認可URLを生成する', () => {
    const url = buildXAuthUrl({
      clientId: 'test-client-id',
      redirectUri: 'https://example.com/callback',
      state: 'test-state',
      codeChallenge: 'test-challenge',
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://twitter.com');
    expect(parsed.pathname).toBe('/i/oauth2/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    expect(parsed.searchParams.get('state')).toBe('test-state');
    expect(parsed.searchParams.get('code_challenge')).toBe('test-challenge');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toContain('tweet.read');
    expect(parsed.searchParams.get('scope')).toContain('users.read');
  });
});

describe('exchangeXCode', () => {
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
      access_token: 'x-access-token',
      token_type: 'bearer',
      expires_in: 7200,
      scope: 'tweet.read users.read offline.access',
      refresh_token: 'x-refresh-token',
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    );

    const result = await exchangeXCode(baseParams);
    expect(result.access_token).toBe('x-access-token');
    expect(result.token_type).toBe('bearer');
    expect(result.refresh_token).toBe('x-refresh-token');
  });

  it('Basic認証ヘッダーでリクエストを送る', async () => {
    const tokenResponse = { access_token: 'token', token_type: 'bearer', scope: '' };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(tokenResponse), { status: 200 })
    );

    await exchangeXCode(baseParams);

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const url = callArgs[0] as string;
    const options = callArgs[1] as RequestInit;
    expect(url).toBe('https://api.twitter.com/2/oauth2/token');
    const expectedCredentials = btoa('client-id:client-secret');
    expect((options.headers as Record<string, string>)['Authorization']).toBe(
      `Basic ${expectedCredentials}`
    );
  });

  it('HTTPエラー時に例外を投げる', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    await expect(exchangeXCode(baseParams)).rejects.toThrow('X token exchange failed');
  });

  it('不正なJSONレスポンス時に明示的なエラーを投げる', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('not-json', { status: 200 }));

    await expect(exchangeXCode(baseParams)).rejects.toThrow(
      'X token exchange failed: Invalid JSON response'
    );
  });
});

describe('fetchXUserInfo', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('正常時にユーザー情報を返す', async () => {
    const userInfo = {
      data: {
        id: 'x-user-123',
        name: 'Test User',
        username: 'testuser',
        profile_image_url: 'https://pbs.twimg.com/test.jpg',
      },
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(userInfo), { status: 200 })
    );

    const result = await fetchXUserInfo('test-access-token');
    expect(result.id).toBe('x-user-123');
    expect(result.name).toBe('Test User');
    expect(result.username).toBe('testuser');
    expect(result.profile_image_url).toBe('https://pbs.twimg.com/test.jpg');
  });

  it('user.fields を含むURLでリクエストする', async () => {
    const userInfo = {
      data: { id: '123', name: 'User', username: 'user' },
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(userInfo), { status: 200 })
    );

    await fetchXUserInfo('test-access-token');

    const callUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(callUrl).toContain('user.fields=');
  });

  it('HTTPエラー時に例外を投げる', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    await expect(fetchXUserInfo('bad-token')).rejects.toThrow('X user info fetch failed: 401');
  });

  it('不正なJSONレスポンス時に明示的なエラーを投げる', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('not-json', { status: 200 }));

    await expect(fetchXUserInfo('test-token')).rejects.toThrow(
      'X user info fetch failed: Invalid JSON response'
    );
  });

  it('profile_image_url なしのユーザー情報も正常に返す', async () => {
    const userInfo = {
      data: { id: 'x-user-456', name: null, username: 'noavatar' },
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(userInfo), { status: 200 })
    );

    const result = await fetchXUserInfo('test-access-token');
    expect(result.id).toBe('x-user-456');
    expect(result.name).toBeNull();
    expect(result.profile_image_url).toBeUndefined();
  });
});
