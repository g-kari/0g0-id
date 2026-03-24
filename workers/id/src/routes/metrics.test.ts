import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@0g0-id/shared', () => ({
  countUsers: vi.fn(),
  countAdminUsers: vi.fn(),
  countServices: vi.fn(),
  countActiveRefreshTokens: vi.fn(),
  countRecentLoginEvents: vi.fn(),
  getLoginEventProviderStats: vi.fn(),
  verifyAccessToken: vi.fn(),
}));

import {
  countUsers,
  countAdminUsers,
  countServices,
  countActiveRefreshTokens,
  countRecentLoginEvents,
  getLoginEventProviderStats,
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
    // 1回目: 全ユーザー数, 2回目: BAN済みユーザー数
    vi.mocked(countUsers).mockResolvedValueOnce(100).mockResolvedValueOnce(3);
    vi.mocked(countAdminUsers).mockResolvedValue(5);
    vi.mocked(countServices).mockResolvedValue(10);
    vi.mocked(countActiveRefreshTokens).mockResolvedValue(42);
    vi.mocked(countRecentLoginEvents).mockResolvedValueOnce(13).mockResolvedValueOnce(87);
    vi.mocked(getLoginEventProviderStats).mockResolvedValue([
      { provider: 'google', count: 60 },
      { provider: 'line', count: 20 },
      { provider: 'github', count: 7 },
    ]);

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
        banned_users: number;
        total_services: number;
        active_sessions: number;
        recent_logins_24h: number;
        recent_logins_7d: number;
        login_provider_stats_7d: { provider: string; count: number }[];
      };
    }>();
    expect(body.data.total_users).toBe(100);
    expect(body.data.admin_users).toBe(5);
    expect(body.data.banned_users).toBe(3);
    expect(body.data.total_services).toBe(10);
    expect(body.data.active_sessions).toBe(42);
    expect(body.data.recent_logins_24h).toBe(13);
    expect(body.data.recent_logins_7d).toBe(87);
    expect(body.data.login_provider_stats_7d).toEqual([
      { provider: 'google', count: 60 },
      { provider: 'line', count: 20 },
      { provider: 'github', count: 7 },
    ]);
  });

  it('管理者トークンでDBへの各カウント関数が呼ばれる', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(countUsers).mockResolvedValue(0);
    vi.mocked(countAdminUsers).mockResolvedValue(0);
    vi.mocked(countServices).mockResolvedValue(0);
    vi.mocked(countActiveRefreshTokens).mockResolvedValue(0);
    vi.mocked(countRecentLoginEvents).mockResolvedValue(0);
    vi.mocked(getLoginEventProviderStats).mockResolvedValue([]);

    await app.request(
      makeRequest('/api/metrics', 'admin-token'),
      undefined,
      mockEnv as unknown as Record<string, string>
    );

    expect(vi.mocked(countUsers)).toHaveBeenCalledWith(mockEnv.DB);
    expect(vi.mocked(countUsers)).toHaveBeenCalledWith(mockEnv.DB, { banned: true });
    expect(vi.mocked(countAdminUsers)).toHaveBeenCalledWith(mockEnv.DB);
    expect(vi.mocked(countServices)).toHaveBeenCalledWith(mockEnv.DB);
    expect(vi.mocked(countActiveRefreshTokens)).toHaveBeenCalledWith(mockEnv.DB);
    expect(vi.mocked(countRecentLoginEvents)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getLoginEventProviderStats)).toHaveBeenCalledWith(
      mockEnv.DB,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    );
  });

  it('countRecentLoginEventsには24h・7d両方の日時が渡される', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(countUsers).mockResolvedValue(0);
    vi.mocked(countAdminUsers).mockResolvedValue(0);
    vi.mocked(countServices).mockResolvedValue(0);
    vi.mocked(countActiveRefreshTokens).mockResolvedValue(0);
    vi.mocked(countRecentLoginEvents).mockResolvedValue(0);
    vi.mocked(getLoginEventProviderStats).mockResolvedValue([]);

    const before = Date.now();
    await app.request(
      makeRequest('/api/metrics', 'admin-token'),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    const after = Date.now();

    const calls = vi.mocked(countRecentLoginEvents).mock.calls;
    expect(calls).toHaveLength(2);

    // 1回目: 24h前
    const since24hMs = new Date(calls[0][1]).getTime();
    expect(since24hMs).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000);
    expect(since24hMs).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000);

    // 2回目: 7d前
    const since7dMs = new Date(calls[1][1]).getTime();
    expect(since7dMs).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000);
    expect(since7dMs).toBeLessThanOrEqual(after - 7 * 24 * 60 * 60 * 1000);
  });

  it('getLoginEventProviderStatsには7d前の日時が渡される', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(countUsers).mockResolvedValue(0);
    vi.mocked(countAdminUsers).mockResolvedValue(0);
    vi.mocked(countServices).mockResolvedValue(0);
    vi.mocked(countActiveRefreshTokens).mockResolvedValue(0);
    vi.mocked(countRecentLoginEvents).mockResolvedValue(0);
    vi.mocked(getLoginEventProviderStats).mockResolvedValue([]);

    const before = Date.now();
    await app.request(
      makeRequest('/api/metrics', 'admin-token'),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    const after = Date.now();

    const calledSince = vi.mocked(getLoginEventProviderStats).mock.calls[0][1];
    const calledSinceMs = new Date(calledSince).getTime();
    expect(calledSinceMs).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000);
    expect(calledSinceMs).toBeLessThanOrEqual(after - 7 * 24 * 60 * 60 * 1000);
  });

  it('プロバイダー統計が空の場合も正常に返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(countUsers).mockResolvedValue(0);
    vi.mocked(countAdminUsers).mockResolvedValue(0);
    vi.mocked(countServices).mockResolvedValue(0);
    vi.mocked(countActiveRefreshTokens).mockResolvedValue(0);
    vi.mocked(countRecentLoginEvents).mockResolvedValue(0);
    vi.mocked(getLoginEventProviderStats).mockResolvedValue([]);

    const res = await app.request(
      makeRequest('/api/metrics', 'admin-token'),
      undefined,
      mockEnv as unknown as Record<string, string>
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ data: { login_provider_stats_7d: unknown[] } }>();
    expect(body.data.login_provider_stats_7d).toEqual([]);
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
