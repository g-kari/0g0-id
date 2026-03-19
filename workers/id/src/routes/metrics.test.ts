import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@0g0-id/shared', () => ({
  countUsers: vi.fn(),
  countAdminUsers: vi.fn(),
  countServices: vi.fn(),
  countActiveRefreshTokens: vi.fn(),
  verifyAccessToken: vi.fn(),
}));

import {
  countUsers,
  countAdminUsers,
  countServices,
  countActiveRefreshTokens,
  verifyAccessToken,
} from '@0g0-id/shared';

import metricsRoutes from './metrics';

const baseUrl = 'https://id.0g0.xyz';

const mockEnv = {
  DB: {} as D1Database,
  JWT_PUBLIC_KEY: 'mock-public-key',
  IDP_ORIGIN: 'https://id.0g0.xyz',
  USER_ORIGIN: 'https://user.0g0.xyz',
  ADMIN_ORIGIN: 'https://admin.0g0.xyz',
};

const mockAdminPayload = {
  iss: 'https://id.0g0.xyz',
  sub: 'admin-user-id',
  aud: 'https://id.0g0.xyz',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  jti: 'jti-admin',
  kid: 'key-1',
  email: 'admin@example.com',
  role: 'admin' as const,
};

const mockUserPayload = {
  ...mockAdminPayload,
  sub: 'regular-user-id',
  email: 'user@example.com',
  role: 'user' as const,
};

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route('/api/metrics', metricsRoutes);
  return app;
}

function makeRequest(path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return new Request(`${baseUrl}${path}`, { headers });
}

describe('GET /api/metrics', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('Authorizationヘッダーなしで401を返す', async () => {
    const res = await app.request(
      makeRequest('/api/metrics'),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(401);
  });

  it('一般ユーザーのトークンで403を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);

    const res = await app.request(
      makeRequest('/api/metrics', 'user-token'),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(403);
  });

  it('管理者トークンでメトリクスデータを返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(countUsers).mockResolvedValue(100);
    vi.mocked(countAdminUsers).mockResolvedValue(5);
    vi.mocked(countServices).mockResolvedValue(10);
    vi.mocked(countActiveRefreshTokens).mockResolvedValue(42);

    const res = await app.request(
      makeRequest('/api/metrics', 'admin-token'),
      undefined,
      mockEnv as unknown as Record<string, string>
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      data: {
        total_users: number;
        admin_users: number;
        total_services: number;
        active_sessions: number;
      };
    }>();
    expect(body.data.total_users).toBe(100);
    expect(body.data.admin_users).toBe(5);
    expect(body.data.total_services).toBe(10);
    expect(body.data.active_sessions).toBe(42);
  });

  it('管理者トークンでDBへの各カウント関数が呼ばれる', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(countUsers).mockResolvedValue(0);
    vi.mocked(countAdminUsers).mockResolvedValue(0);
    vi.mocked(countServices).mockResolvedValue(0);
    vi.mocked(countActiveRefreshTokens).mockResolvedValue(0);

    await app.request(
      makeRequest('/api/metrics', 'admin-token'),
      undefined,
      mockEnv as unknown as Record<string, string>
    );

    expect(vi.mocked(countUsers)).toHaveBeenCalledWith(mockEnv.DB);
    expect(vi.mocked(countAdminUsers)).toHaveBeenCalledWith(mockEnv.DB);
    expect(vi.mocked(countServices)).toHaveBeenCalledWith(mockEnv.DB);
    expect(vi.mocked(countActiveRefreshTokens)).toHaveBeenCalledWith(mockEnv.DB);
  });

  it('無効なトークンで401を返す', async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error('invalid token'));

    const res = await app.request(
      makeRequest('/api/metrics', 'invalid-token'),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(401);
  });
});
