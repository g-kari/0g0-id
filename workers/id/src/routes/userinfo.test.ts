import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@0g0-id/shared', async (importActual) => {
  const actual = await importActual<typeof import('@0g0-id/shared')>();
  return {
    ...actual,
    findUserById: vi.fn(),
    verifyAccessToken: vi.fn(),
    sha256: vi.fn(),
    isAccessTokenRevoked: vi.fn().mockResolvedValue(false),
  };
});

vi.mock('../middleware/rate-limit', () => ({
  externalApiRateLimitMiddleware: vi.fn((c, next) => next()),
}));

import { findUserById, verifyAccessToken, sha256 } from '@0g0-id/shared';
import type { TokenPayload } from '@0g0-id/shared';
import { externalApiRateLimitMiddleware } from '../middleware/rate-limit';
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
  banned_at: null,
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

    it('BANされたユーザー → 401を返す', async () => {
      vi.mocked(findUserById).mockResolvedValue({ ...mockUser, banned_at: '2024-06-01T00:00:00Z' });
      const res = await requestUserInfo(app);
      expect(res.status).toBe(401);
      const body = await res.json<{ error: string; error_description: string }>();
      expect(body.error).toBe('invalid_token');
      expect(body.error_description).toBe('Account suspended');
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

    it('scopeなし（BFFセッション）ではphone/addressを返さない', async () => {
      const res = await requestUserInfo(app);
      const body = await res.json<Record<string, unknown>>();
      expect(body).not.toHaveProperty('phone_number');
      expect(body).not.toHaveProperty('address');
    });
  });

  describe('スコープベースのクレームフィルタリング（OIDC Core 1.0 Section 5.3）', () => {
    it('scope=openid profile → name/pictureを返し、email/phone/addressを返さない', async () => {
      vi.mocked(verifyAccessToken).mockResolvedValue({
        ...mockTokenPayload,
        scope: 'openid profile',
      } as never);
      const res = await requestUserInfo(app);
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body).toHaveProperty('sub');
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('picture');
      expect(body).not.toHaveProperty('email');
      expect(body).not.toHaveProperty('email_verified');
      expect(body).not.toHaveProperty('phone_number');
      expect(body).not.toHaveProperty('address');
    });

    it('scope=openid email → email/email_verifiedを返し、name/pictureを返さない', async () => {
      vi.mocked(verifyAccessToken).mockResolvedValue({
        ...mockTokenPayload,
        scope: 'openid email',
      } as never);
      const res = await requestUserInfo(app);
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body).toHaveProperty('sub');
      expect(body).toHaveProperty('email');
      expect(body).toHaveProperty('email_verified');
      expect(body).not.toHaveProperty('name');
      expect(body).not.toHaveProperty('picture');
    });

    it('scope=openid profile email → name/picture/email/email_verifiedを全て返す', async () => {
      vi.mocked(verifyAccessToken).mockResolvedValue({
        ...mockTokenPayload,
        scope: 'openid profile email',
      } as never);
      const res = await requestUserInfo(app);
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('picture');
      expect(body).toHaveProperty('email');
      expect(body).toHaveProperty('email_verified');
    });

    it('scope=openid phone → phone_numberを返す（ユーザーに電話番号がある場合）', async () => {
      vi.mocked(verifyAccessToken).mockResolvedValue({
        ...mockTokenPayload,
        scope: 'openid phone',
      } as never);
      const res = await requestUserInfo(app);
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body).toHaveProperty('phone_number', '090-0000-0000');
      expect(body).not.toHaveProperty('name');
      expect(body).not.toHaveProperty('email');
    });

    it('scope=openid phone → phone_numberを返さない（ユーザーに電話番号がない場合）', async () => {
      vi.mocked(verifyAccessToken).mockResolvedValue({
        ...mockTokenPayload,
        scope: 'openid phone',
      } as never);
      vi.mocked(findUserById).mockResolvedValue({ ...mockUser, phone: null });
      const res = await requestUserInfo(app);
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body).not.toHaveProperty('phone_number');
    });

    it('scope=openid address → addressを返す（ユーザーに住所がある場合）', async () => {
      vi.mocked(verifyAccessToken).mockResolvedValue({
        ...mockTokenPayload,
        scope: 'openid address',
      } as never);
      const res = await requestUserInfo(app);
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body).toHaveProperty('address', { formatted: 'Tokyo' });
    });

    it('scopeなし（BFFセッション）→ name/picture/email/email_verifiedを返す（後方互換）', async () => {
      vi.mocked(verifyAccessToken).mockResolvedValue({
        ...mockTokenPayload,
        scope: undefined,
      } as never);
      const res = await requestUserInfo(app);
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('picture');
      expect(body).toHaveProperty('email');
      expect(body).toHaveProperty('email_verified');
    });

    it('updated_atは常にUNIXタイムスタンプで返す', async () => {
      vi.mocked(verifyAccessToken).mockResolvedValue({
        ...mockTokenPayload,
        scope: 'openid profile',
      } as never);
      const res = await requestUserInfo(app);
      const body = await res.json<{ updated_at: number }>();
      expect(typeof body.updated_at).toBe('number');
    });
  });

  describe('ペアワイズsub（サービストークン）', () => {
    it('cid付きトークン → sha256(cid:userId)のペアワイズsubを返す', async () => {
      vi.mocked(verifyAccessToken).mockResolvedValue({
        ...mockTokenPayload,
        scope: 'openid profile email',
        cid: 'test-client-id',
      } as never);
      vi.mocked(sha256).mockResolvedValue('pairwise-sub-hash');
      const res = await requestUserInfo(app);
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body.sub).toBe('pairwise-sub-hash');
      expect(vi.mocked(sha256)).toHaveBeenCalledWith('test-client-id:user-1');
    });

    it('cidなしトークン（BFFセッション）→ 内部IDをそのまま返す', async () => {
      vi.mocked(verifyAccessToken).mockResolvedValue({
        ...mockTokenPayload,
        scope: undefined,
        cid: undefined,
      } as never);
      const res = await requestUserInfo(app);
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body.sub).toBe('user-1');
      expect(vi.mocked(sha256)).not.toHaveBeenCalled();
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

describe('レートリミット', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockTokenPayload as never);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(externalApiRateLimitMiddleware).mockImplementation((c, next) => next());
  });

  it('GETリクエストにexternalApiRateLimitMiddlewareが適用される', async () => {
    await requestUserInfo(app, 'GET');
    expect(vi.mocked(externalApiRateLimitMiddleware)).toHaveBeenCalled();
  });

  it('POSTリクエストにexternalApiRateLimitMiddlewareが適用される', async () => {
    await requestUserInfo(app, 'POST');
    expect(vi.mocked(externalApiRateLimitMiddleware)).toHaveBeenCalled();
  });

  it('レートリミット超過時は429を返す', async () => {
    vi.mocked(externalApiRateLimitMiddleware).mockImplementationOnce(async (c) => {
      return c.json(
        { error: { code: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded.' } },
        429
      ) as unknown as void;
    });
    const res = await requestUserInfo(app, 'GET');
    expect(res.status).toBe(429);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('TOO_MANY_REQUESTS');
  });
});
