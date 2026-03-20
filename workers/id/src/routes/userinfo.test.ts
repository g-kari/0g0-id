import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@0g0-id/shared', () => ({
  findUserById: vi.fn(),
  verifyAccessToken: vi.fn(),
}));

import { findUserById, verifyAccessToken } from '@0g0-id/shared';
import type { TokenPayload } from '@0g0-id/shared';
import userInfoRoutes from './userinfo';

const baseUrl = 'https://id.0g0.xyz';

const mockEnv = {
  DB: {} as D1Database,
  IDP_ORIGIN: 'https://id.0g0.xyz',
  USER_ORIGIN: 'https://user.0g0.xyz',
  ADMIN_ORIGIN: 'https://admin.0g0.xyz',
  JWT_PRIVATE_KEY: 'mock-private-key',
  JWT_PUBLIC_KEY: 'mock-public-key',
};

const mockTokenPayload: TokenPayload = {
  sub: 'user-1',
  email: 'test@example.com',
  role: 'user',
  iss: 'https://id.0g0.xyz',
  aud: 'https://id.0g0.xyz',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 900,
  jti: 'jti-1',
  kid: 'kid-1',
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
  phone: '090-0000-0000',
  address: 'Tokyo',
  role: 'user' as const,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-06-15T12:00:00Z',
};

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route('/api/userinfo', userInfoRoutes);
  return app;
}

function makeRequest(method: 'GET' | 'POST', token?: string): Request {
  return new Request(`${baseUrl}/api/userinfo`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function requestUserInfo(
  app: ReturnType<typeof buildApp>,
  method: 'GET' | 'POST' = 'GET',
  token = 'valid-token'
): Promise<Response> {
  return app.request(
    makeRequest(method, token),
    undefined,
    mockEnv as unknown as Record<string, string>
  );
}

describe('GET /api/userinfo', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockTokenPayload as never);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
  });

  describe('認証', () => {
    it('Authorizationヘッダーなし → 401を返す', async () => {
      const res = await app.request(
        makeRequest('GET', undefined),
        undefined,
        mockEnv as unknown as Record<string, string>
      );
      expect(res.status).toBe(401);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('無効なトークン → 401を返す', async () => {
      vi.mocked(verifyAccessToken).mockRejectedValue(new Error('invalid token'));
      const res = await requestUserInfo(app, 'GET', 'invalid-token');
      expect(res.status).toBe(401);
    });

    it('期限切れトークン → 401を返す', async () => {
      vi.mocked(verifyAccessToken).mockRejectedValue(new Error('token expired'));
      const res = await requestUserInfo(app, 'GET', 'expired-token');
      expect(res.status).toBe(401);
    });
  });

  describe('ユーザー情報取得', () => {
    it('200を返してユーザークレームを返す', async () => {
      const res = await requestUserInfo(app);
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body.sub).toBe('user-1');
      expect(body.name).toBe('Test User');
      expect(body.email).toBe('test@example.com');
      expect(body.email_verified).toBe(true);
      expect(body.picture).toBe('https://example.com/pic.jpg');
    });

    it('updated_atをUNIXタイムスタンプ（秒）で返す', async () => {
      const res = await requestUserInfo(app);
      const body = await res.json<{ updated_at: number }>();
      expect(body.updated_at).toBe(Math.floor(new Date('2024-06-15T12:00:00Z').getTime() / 1000));
    });

    it('email_verified=0のユーザー → email_verified: falseを返す', async () => {
      vi.mocked(findUserById).mockResolvedValue({ ...mockUser, email_verified: 0 });
      const res = await requestUserInfo(app);
      const body = await res.json<{ email_verified: boolean }>();
      expect(body.email_verified).toBe(false);
    });

    it('存在しないユーザー（DB上に見つからない） → 401を返す', async () => {
      vi.mocked(findUserById).mockResolvedValue(null);
      const res = await requestUserInfo(app);
      expect(res.status).toBe(401);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe('invalid_token');
    });
  });

  describe('セキュリティ: 内部情報の非公開', () => {
    it('内部フィールド（google_sub等）を返さない', async () => {
      const res = await requestUserInfo(app);
      const body = await res.json<Record<string, unknown>>();
      expect(body).not.toHaveProperty('google_sub');
      expect(body).not.toHaveProperty('line_sub');
      expect(body).not.toHaveProperty('twitch_sub');
      expect(body).not.toHaveProperty('github_sub');
      expect(body).not.toHaveProperty('x_sub');
    });

    it('roleを返さない', async () => {
      const res = await requestUserInfo(app);
      const body = await res.json<Record<string, unknown>>();
      expect(body).not.toHaveProperty('role');
    });

    it('phone/addressを返さない（標準クレーム外）', async () => {
      const res = await requestUserInfo(app);
      const body = await res.json<Record<string, unknown>>();
      expect(body).not.toHaveProperty('phone');
      expect(body).not.toHaveProperty('address');
    });
  });

  describe('verifyAccessTokenへの正しい引数渡し', () => {
    it('公開鍵・issuer・audienceを正しく渡す', async () => {
      await requestUserInfo(app);
      expect(vi.mocked(verifyAccessToken)).toHaveBeenCalledWith(
        'valid-token',
        mockEnv.JWT_PUBLIC_KEY,
        mockEnv.IDP_ORIGIN,
        mockEnv.IDP_ORIGIN
      );
    });
  });
});

describe('POST /api/userinfo', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockTokenPayload as never);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
  });

  it('POSTでも200を返してユーザークレームを返す（OIDC Core 1.0 要件）', async () => {
    const res = await requestUserInfo(app, 'POST');
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.sub).toBe('user-1');
    expect(body.email).toBe('test@example.com');
  });

  it('POSTでもAuthorizationヘッダーなし → 401を返す', async () => {
    const res = await app.request(
      makeRequest('POST', undefined),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(401);
  });
});
