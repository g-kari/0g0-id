import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// @0g0-id/sharedの全関数をモック
vi.mock('@0g0-id/shared', () => ({
  buildGoogleAuthUrl: vi.fn(),
  exchangeGoogleCode: vi.fn(),
  fetchGoogleUserInfo: vi.fn(),
  buildLineAuthUrl: vi.fn(),
  exchangeLineCode: vi.fn(),
  fetchLineUserInfo: vi.fn(),
  buildTwitchAuthUrl: vi.fn(),
  exchangeTwitchCode: vi.fn(),
  fetchTwitchUserInfo: vi.fn(),
  buildGithubAuthUrl: vi.fn(),
  exchangeGithubCode: vi.fn(),
  fetchGithubUserInfo: vi.fn(),
  fetchGithubPrimaryEmail: vi.fn(),
  buildXAuthUrl: vi.fn(),
  exchangeXCode: vi.fn(),
  fetchXUserInfo: vi.fn(),
  generateCodeVerifier: vi.fn(),
  generateCodeChallenge: vi.fn(),
  generateToken: vi.fn(),
  sha256: vi.fn(),
  signAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  findRefreshTokenByHash: vi.fn(),
  findUserById: vi.fn(),
  revokeRefreshToken: vi.fn(),
  revokeTokenFamily: vi.fn(),
  upsertUser: vi.fn(),
  upsertLineUser: vi.fn(),
  upsertTwitchUser: vi.fn(),
  upsertGithubUser: vi.fn(),
  upsertXUser: vi.fn(),
  updateUserRole: vi.fn(),
  countAdminUsers: vi.fn(),
  createAuthCode: vi.fn(),
  findAndConsumeAuthCode: vi.fn(),
  linkProvider: vi.fn(),
}));

import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  buildLineAuthUrl,
  buildGithubAuthUrl,
  generateCodeVerifier,
  generateCodeChallenge,
  generateToken,
  sha256,
  signAccessToken,
  createRefreshToken,
  findRefreshTokenByHash,
  findUserById,
  revokeRefreshToken,
  revokeTokenFamily,
  upsertUser,
  countAdminUsers,
  createAuthCode,
  findAndConsumeAuthCode,
} from '@0g0-id/shared';

import authRoutes from './auth';

const baseUrl = 'https://id.0g0.xyz';

const mockEnv = {
  DB: {} as D1Database,
  IDP_ORIGIN: 'https://id.0g0.xyz',
  USER_ORIGIN: 'https://user.0g0.xyz',
  ADMIN_ORIGIN: 'https://admin.0g0.xyz',
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  LINE_CLIENT_ID: 'line-client-id',
  LINE_CLIENT_SECRET: 'line-client-secret',
  TWITCH_CLIENT_ID: 'twitch-client-id',
  TWITCH_CLIENT_SECRET: 'twitch-client-secret',
  GITHUB_CLIENT_ID: 'github-client-id',
  GITHUB_CLIENT_SECRET: 'github-client-secret',
  X_CLIENT_ID: 'x-client-id',
  X_CLIENT_SECRET: 'x-client-secret',
  JWT_PRIVATE_KEY: 'mock-private-key',
  JWT_PUBLIC_KEY: 'mock-public-key',
};

const mockUser = {
  id: 'user-1',
  google_sub: 'google-sub-1',
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: 'test@example.com',
  email_verified: 1,
  name: 'Test User',
  picture: 'https://example.com/pic.jpg',
  phone: null,
  address: null,
  role: 'user' as const,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route('/auth', authRoutes);
  return app;
}

async function sendRequest(
  app: ReturnType<typeof buildApp>,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
) {
  const { method = 'GET', body, headers = {} } = options;
  const reqHeaders: Record<string, string> = { ...headers };
  if (body) reqHeaders['Content-Type'] = 'application/json';

  return app.request(
    new Request(`${baseUrl}${path}`, {
      method,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : undefined,
    }),
    undefined,
    mockEnv as unknown as Record<string, string>
  );
}

// Cookieつきのstate/PKCEセットアップ用ヘルパー
function buildStateCookie(data: {
  idState: string;
  bffState: string;
  redirectTo: string;
  provider: string;
  linkUserId?: string;
}): string {
  return btoa(encodeURIComponent(JSON.stringify(data)));
}

// ===== GET /auth/login =====
describe('GET /auth/login', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateToken).mockReturnValue('mock-token-16');
    vi.mocked(generateCodeVerifier).mockReturnValue('mock-code-verifier');
    vi.mocked(generateCodeChallenge).mockResolvedValue('mock-code-challenge');
    vi.mocked(buildGoogleAuthUrl).mockReturnValue('https://accounts.google.com/o/oauth2/auth?...');
    vi.mocked(buildLineAuthUrl).mockReturnValue('https://access.line.me/oauth2/v2.1/authorize?...');
    vi.mocked(buildGithubAuthUrl).mockReturnValue('https://github.com/login/oauth/authorize?...');
  });

  it('redirect_toが未指定 → 400を返す', async () => {
    const res = await sendRequest(app, '/auth/login?state=bff-state');
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('stateが未指定 → 400を返す', async () => {
    const res = await sendRequest(
      app,
      '/auth/login?redirect_to=https://user.0g0.xyz/callback'
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('不正なprovider → 400を返す', async () => {
    const res = await sendRequest(
      app,
      '/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=unknown'
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('不正なredirect_to（許可外オリジン）→ 400を返す', async () => {
    const res = await sendRequest(
      app,
      '/auth/login?redirect_to=https://evil.com/callback&state=bff-state'
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('Google: 正常なリクエスト → Googleへリダイレクト', async () => {
    const res = await sendRequest(
      app,
      '/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=google'
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('accounts.google.com');
  });

  it('LINE: 正常なリクエスト → LINEへリダイレクト', async () => {
    const res = await sendRequest(
      app,
      '/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=line'
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('access.line.me');
  });

  it('GitHub: 正常なリクエスト → GitHubへリダイレクト', async () => {
    const res = await sendRequest(
      app,
      '/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=github'
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('github.com');
  });

  it('LINE: クレデンシャル未設定 → 400を返す', async () => {
    const envWithoutLine = { ...mockEnv, LINE_CLIENT_ID: '', LINE_CLIENT_SECRET: '' };
    const res = await buildApp().request(
      new Request(
        `${baseUrl}/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=line`
      ),
      undefined,
      envWithoutLine as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('adminオリジンのredirect_toも許可', async () => {
    const res = await sendRequest(
      app,
      '/auth/login?redirect_to=https://admin.0g0.xyz/callback&state=bff-state&provider=google'
    );
    expect(res.status).toBe(302);
  });
});

// ===== GET /auth/callback =====
describe('GET /auth/callback', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue('hashed-value');
    vi.mocked(generateToken).mockReturnValue('mock-auth-code');
    vi.mocked(upsertUser).mockResolvedValue(mockUser);
    vi.mocked(countAdminUsers).mockResolvedValue(1);
    vi.mocked(createAuthCode).mockResolvedValue(undefined as never);
    vi.mocked(exchangeGoogleCode).mockResolvedValue({ access_token: 'google-at' } as never);
    vi.mocked(fetchGoogleUserInfo).mockResolvedValue({
      sub: 'google-sub-1',
      email: 'test@example.com',
      email_verified: true,
      name: 'Test User',
      picture: 'https://example.com/pic.jpg',
    } as never);
  });

  it('errorパラメータあり → 400を返す', async () => {
    const res = await sendRequest(app, '/auth/callback?error=access_denied');
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('OAUTH_ERROR');
  });

  it('codeまたはstateが未指定 → 400を返す', async () => {
    const res = await sendRequest(app, '/auth/callback?code=abc');
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('Cookieなし → 400を返す', async () => {
    const res = await sendRequest(app, '/auth/callback?code=abc&state=some-state');
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('state不一致 → 400を返す', async () => {
    const stateData = buildStateCookie({
      idState: 'correct-state',
      bffState: 'bff-state',
      redirectTo: 'https://user.0g0.xyz/callback',
      provider: 'google',
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=wrong-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('Googleコールバック正常 → BFFコールバックへリダイレクト', async () => {
    const stateData = buildStateCookie({
      idState: 'correct-state',
      bffState: 'bff-state',
      redirectTo: 'https://user.0g0.xyz/callback',
      provider: 'google',
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('https://user.0g0.xyz/callback');
    expect(location).toContain('state=bff-state');
  });

  it('Googleコールバック: メール未確認 → 400を返す', async () => {
    vi.mocked(fetchGoogleUserInfo).mockResolvedValue({
      sub: 'google-sub-1',
      email: 'test@example.com',
      email_verified: false,
      name: 'Test User',
      picture: null,
    } as never);
    const stateData = buildStateCookie({
      idState: 'correct-state',
      bffState: 'bff-state',
      redirectTo: 'https://user.0g0.xyz/callback',
      provider: 'google',
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UNVERIFIED_EMAIL');
  });

  it('不正なstate cookie → 400を返す', async () => {
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=some-state`, {
        headers: {
          Cookie: `__Host-oauth-state=!!!invalid-base64!!!; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });
});

// ===== POST /auth/exchange =====
describe('POST /auth/exchange', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue('hashed-code');
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
      id: 'code-id',
      user_id: 'user-1',
      code_hash: 'hashed-code',
      redirect_to: 'https://user.0g0.xyz/callback',
      expires_at: new Date(Date.now() + 60000).toISOString(),
      created_at: '2024-01-01T00:00:00Z',
    } as never);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(signAccessToken).mockResolvedValue('mock-access-token');
    vi.mocked(createRefreshToken).mockResolvedValue(undefined as never);
  });

  it('JSONボディが不正 → 400を返す', async () => {
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('codeまたはredirect_toが未指定 → 400を返す', async () => {
    const res = await sendRequest(app, '/auth/exchange', {
      method: 'POST',
      body: { code: 'some-code' },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('無効なコード → 400を返す', async () => {
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue(null);
    const res = await sendRequest(app, '/auth/exchange', {
      method: 'POST',
      body: { code: 'invalid-code', redirect_to: 'https://user.0g0.xyz/callback' },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('INVALID_CODE');
  });

  it('redirect_to不一致 → 400を返す', async () => {
    const res = await sendRequest(app, '/auth/exchange', {
      method: 'POST',
      body: { code: 'valid-code', redirect_to: 'https://admin.0g0.xyz/callback' },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('INVALID_CODE');
  });

  it('ユーザー不存在 → 404を返す', async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, '/auth/exchange', {
      method: 'POST',
      body: { code: 'valid-code', redirect_to: 'https://user.0g0.xyz/callback' },
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('正常なコード交換 → アクセストークンとリフレッシュトークンを返す', async () => {
    const res = await sendRequest(app, '/auth/exchange', {
      method: 'POST',
      body: { code: 'valid-code', redirect_to: 'https://user.0g0.xyz/callback' },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
        user: { id: string; email: string };
      };
    }>();
    expect(body.data.access_token).toBe('mock-access-token');
    expect(body.data.token_type).toBe('Bearer');
    expect(body.data.expires_in).toBe(900);
    expect(body.data.user.id).toBe('user-1');
    expect(body.data.user.email).toBe('test@example.com');
  });
});

// ===== POST /auth/refresh =====
describe('POST /auth/refresh', () => {
  const app = buildApp();

  const mockRefreshToken = {
    id: 'rt-id',
    user_id: 'user-1',
    service_id: null,
    token_hash: 'hashed-token',
    family_id: 'family-1',
    revoked_at: null,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue('hashed-token');
    vi.mocked(generateToken).mockReturnValue('new-refresh-token-raw');
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken as never);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(signAccessToken).mockResolvedValue('new-access-token');
    vi.mocked(revokeRefreshToken).mockResolvedValue(undefined as never);
    vi.mocked(createRefreshToken).mockResolvedValue(undefined as never);
  });

  it('JSONボディが不正 → 400を返す', async () => {
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('refresh_tokenが未指定 → 400を返す', async () => {
    const res = await sendRequest(app, '/auth/refresh', {
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('トークンが存在しない → 401を返す', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    const res = await sendRequest(app, '/auth/refresh', {
      method: 'POST',
      body: { refresh_token: 'invalid-token' },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  it('失効済みトークン（リプレイ攻撃）→ family全失効 + 401を返す', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: '2024-01-01T00:00:00Z',
    } as never);
    vi.mocked(revokeTokenFamily).mockResolvedValue(undefined as never);

    const res = await sendRequest(app, '/auth/refresh', {
      method: 'POST',
      body: { refresh_token: 'revoked-token' },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('TOKEN_REUSE');
    expect(vi.mocked(revokeTokenFamily)).toHaveBeenCalledWith(
      mockEnv.DB,
      'family-1'
    );
  });

  it('期限切れトークン → 401を返す', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    } as never);

    const res = await sendRequest(app, '/auth/refresh', {
      method: 'POST',
      body: { refresh_token: 'expired-token' },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('ユーザー不存在 → 404を返す', async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, '/auth/refresh', {
      method: 'POST',
      body: { refresh_token: 'valid-token' },
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('正常なリフレッシュ → 新しいトークンペアを返す', async () => {
    const res = await sendRequest(app, '/auth/refresh', {
      method: 'POST',
      body: { refresh_token: 'valid-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: { access_token: string; refresh_token: string; token_type: string; expires_in: number };
    }>();
    expect(body.data.access_token).toBe('new-access-token');
    expect(body.data.token_type).toBe('Bearer');
    expect(body.data.expires_in).toBe(900);
    expect(body.data.refresh_token).toBeTruthy();
    // 旧トークンを失効させることを確認
    expect(vi.mocked(revokeRefreshToken)).toHaveBeenCalledWith(mockEnv.DB, 'rt-id');
    // 新トークンを同じfamily_idで発行することを確認
    expect(vi.mocked(createRefreshToken)).toHaveBeenCalledWith(
      mockEnv.DB,
      expect.objectContaining({ familyId: 'family-1' })
    );
  });
});

// ===== POST /auth/logout =====
describe('POST /auth/logout', () => {
  const app = buildApp();

  const mockRefreshToken = {
    id: 'rt-id',
    user_id: 'user-1',
    service_id: null,
    token_hash: 'hashed-token',
    family_id: 'family-1',
    revoked_at: null,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue('hashed-token');
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken as never);
    vi.mocked(revokeTokenFamily).mockResolvedValue(undefined as never);
  });

  it('JSONボディが不正 → 400を返す', async () => {
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('refresh_tokenなし → successを返す（冪等）', async () => {
    const res = await sendRequest(app, '/auth/logout', {
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { success: boolean } }>();
    expect(body.data.success).toBe(true);
    expect(vi.mocked(revokeTokenFamily)).not.toHaveBeenCalled();
  });

  it('有効なrefresh_token → family全失効 + successを返す', async () => {
    const res = await sendRequest(app, '/auth/logout', {
      method: 'POST',
      body: { refresh_token: 'valid-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { success: boolean } }>();
    expect(body.data.success).toBe(true);
    expect(vi.mocked(revokeTokenFamily)).toHaveBeenCalledWith(mockEnv.DB, 'family-1');
  });

  it('存在しないrefresh_token → エラーなくsuccessを返す', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    const res = await sendRequest(app, '/auth/logout', {
      method: 'POST',
      body: { refresh_token: 'unknown-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { success: boolean } }>();
    expect(body.data.success).toBe(true);
  });
});
