import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@0g0-id/shared', () => ({
  verifyAccessToken: vi.fn(),
}));

import { verifyAccessToken } from '@0g0-id/shared';
import type { TokenPayload } from '@0g0-id/shared';
import { authMiddleware } from './auth';

const baseUrl = 'https://id.0g0.xyz';

const mockEnv = {
  DB: {} as D1Database,
  IDP_ORIGIN: 'https://id.0g0.xyz',
  USER_ORIGIN: 'https://user.0g0.xyz',
  ADMIN_ORIGIN: 'https://admin.0g0.xyz',
  JWT_PRIVATE_KEY: 'mock-private-key',
  JWT_PUBLIC_KEY: 'mock-public-key',
};

const mockPayload = {
  sub: 'user-1',
  email: 'test@example.com',
  role: 'user' as const,
  iss: 'https://id.0g0.xyz',
  aud: 'https://id.0g0.xyz',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 900,
  jti: 'jti-1',
  kid: 'kid-1',
};

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv; Variables: { user: TokenPayload } }>();
  app.use('/protected/*', authMiddleware);
  app.get('/protected/resource', (c) => {
    const user = c.get('user');
    return c.json({ ok: true, userId: user.sub });
  });
  return app;
}

describe('authMiddleware', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('Authorizationヘッダーなし → 401を返す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('Bearer以外のスキーム → 401を返す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`, {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('無効なトークン → 401を返す', async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error('invalid token'));

    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`, {
        headers: { Authorization: 'Bearer invalid-token' },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('有効なトークン → 200を返してuserをコンテキストに設定する', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockPayload as never);

    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`, {
        headers: { Authorization: 'Bearer valid-token' },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; userId: string }>();
    expect(body.ok).toBe(true);
    expect(body.userId).toBe('user-1');

    expect(vi.mocked(verifyAccessToken)).toHaveBeenCalledWith(
      'valid-token',
      mockEnv.JWT_PUBLIC_KEY,
      mockEnv.IDP_ORIGIN,
      mockEnv.IDP_ORIGIN
    );
  });

  it('期限切れトークン（検証失敗）→ 401を返す', async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error('token expired'));

    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`, {
        headers: { Authorization: 'Bearer expired-token' },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(401);
  });
});
