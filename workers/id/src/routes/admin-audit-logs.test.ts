import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@0g0-id/shared', () => ({
  createLogger: vi.fn().mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  findUserById: vi.fn(),
  listAdminAuditLogs: vi.fn(),
  getAuditLogStats: vi.fn(),
  parseDays: (daysParam: string | undefined, options: { minDays?: number; maxDays?: number } = {}) => {
    if (daysParam === undefined) return undefined;
    const { minDays = 1, maxDays = 90 } = options;
    const days = parseInt(daysParam, 10);
    if (!Number.isInteger(days) || days < minDays || days > maxDays) {
      return { error: { code: 'INVALID_REQUEST', message: `days must be an integer between ${minDays} and ${maxDays}` } };
    }
    return { days };
  },
  parsePagination: (
    query: { limit?: string; offset?: string },
    options: { defaultLimit: number; maxLimit: number } = { defaultLimit: 50, maxLimit: 100 }
  ) => {
    const limitRaw = query.limit !== undefined ? parseInt(query.limit, 10) : options.defaultLimit;
    const offsetRaw = query.offset !== undefined ? parseInt(query.offset, 10) : 0;
    if (query.limit !== undefined && (isNaN(limitRaw) || limitRaw < 1)) {
      return { error: 'limit は1以上の整数で指定してください' };
    }
    if (query.offset !== undefined && (isNaN(offsetRaw) || offsetRaw < 0)) {
      return { error: 'offset は0以上の整数で指定してください' };
    }
    return { limit: Math.min(limitRaw, options.maxLimit), offset: offsetRaw };
  },
  verifyAccessToken: vi.fn(),
  isAccessTokenRevoked: vi.fn().mockResolvedValue(false),
}));

import {
  findUserById,
  listAdminAuditLogs,
  getAuditLogStats,
  verifyAccessToken,
} from '@0g0-id/shared';
import type { AdminAuditLog } from '@0g0-id/shared';

import auditLogsRoutes from './admin-audit-logs';

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

function createApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route('/api/admin/audit-logs', auditLogsRoutes);
  return app;
}

function makeRequest(path: string, options: { withAuth?: boolean } = {}) {
  const { withAuth = true } = options;
  const headers: Record<string, string> = {};
  if (withAuth) headers['Authorization'] = 'Bearer mock-token';
  return new Request(`${baseUrl}${path}`, { headers });
}

const mockLog: AdminAuditLog = {
  id: 'log-1',
  admin_user_id: 'admin-user-id',
  action: 'user.ban',
  target_type: 'user',
  target_id: 'target-user-id',
  details: JSON.stringify({ reason: 'spam' }),
  ip_address: '127.0.0.1',
  status: 'success',
  created_at: '2026-03-27T00:00:00.000Z',
};

describe('GET /api/admin/audit-logs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // adminMiddlewareがfindUserByIdでBANチェックするため、デフォルトで有効な管理者を返す
    vi.mocked(findUserById).mockResolvedValue({ id: 'admin-user-id', email: 'admin@example.com', role: 'admin', banned_at: null } as any);
  });

  it('管理者は監査ログ一覧を取得できる', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(listAdminAuditLogs).mockResolvedValue({ logs: [mockLog], total: 1 });

    const app = createApp();
    const res = await app.request(makeRequest('/api/admin/audit-logs'), undefined, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json() as { data: AdminAuditLog[]; pagination: { total: number; limit: number; offset: number } };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].action).toBe('user.ban');
    expect(body.pagination.total).toBe(1);
    expect(body.pagination.limit).toBe(50);
    expect(body.pagination.offset).toBe(0);
  });

  it('admin_user_id フィルタが渡される', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(listAdminAuditLogs).mockResolvedValue({ logs: [], total: 0 });

    const app = createApp();
    await app.request(makeRequest('/api/admin/audit-logs?admin_user_id=admin-user-id'), undefined, mockEnv);

    expect(listAdminAuditLogs).toHaveBeenCalledWith(
      mockEnv.DB,
      50,
      0,
      expect.objectContaining({ adminUserId: 'admin-user-id' })
    );
  });

  it('target_id フィルタが渡される', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(listAdminAuditLogs).mockResolvedValue({ logs: [], total: 0 });

    const app = createApp();
    await app.request(makeRequest('/api/admin/audit-logs?target_id=target-user-id'), undefined, mockEnv);

    expect(listAdminAuditLogs).toHaveBeenCalledWith(
      mockEnv.DB,
      50,
      0,
      expect.objectContaining({ targetId: 'target-user-id' })
    );
  });

  it('action フィルタが渡される', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(listAdminAuditLogs).mockResolvedValue({ logs: [], total: 0 });

    const app = createApp();
    await app.request(makeRequest('/api/admin/audit-logs?action=user.ban'), undefined, mockEnv);

    expect(listAdminAuditLogs).toHaveBeenCalledWith(
      mockEnv.DB,
      50,
      0,
      expect.objectContaining({ action: 'user.ban' })
    );
  });

  it('ページネーションパラメータが渡される', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(listAdminAuditLogs).mockResolvedValue({ logs: [], total: 0 });

    const app = createApp();
    await app.request(makeRequest('/api/admin/audit-logs?limit=10&offset=20'), undefined, mockEnv);

    expect(listAdminAuditLogs).toHaveBeenCalledWith(mockEnv.DB, 10, 20, expect.any(Object));
  });

  it('不正な limit は 400 を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);

    const app = createApp();
    const res = await app.request(makeRequest('/api/admin/audit-logs?limit=0'), undefined, mockEnv);

    expect(res.status).toBe(400);
  });

  it('一般ユーザーは 403 を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);

    const app = createApp();
    const res = await app.request(makeRequest('/api/admin/audit-logs'), undefined, mockEnv);

    expect(res.status).toBe(403);
  });

  it('未認証は 401 を返す', async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error('Unauthorized'));

    const app = createApp();
    const res = await app.request(makeRequest('/api/admin/audit-logs', { withAuth: false }), undefined, mockEnv);

    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/audit-logs/stats', () => {
  const mockStats = {
    action_stats: [
      { action: 'user.ban', count: 5 },
      { action: 'user.role_change', count: 3 },
    ],
    admin_stats: [
      { admin_user_id: 'admin-user-id', count: 8 },
    ],
    daily_stats: [
      { date: '2026-03-27', count: 2 },
      { date: '2026-03-26', count: 3 },
    ],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    // adminMiddlewareがfindUserByIdでBANチェックするため、デフォルトで有効な管理者を返す
    vi.mocked(findUserById).mockResolvedValue({ id: 'admin-user-id', email: 'admin@example.com', role: 'admin', banned_at: null } as any);
  });

  it('管理者は統計情報を取得できる', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getAuditLogStats).mockResolvedValue(mockStats);

    const app = createApp();
    const res = await app.request(makeRequest('/api/admin/audit-logs/stats'), undefined, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json() as { data: typeof mockStats; days: number };
    expect(body.data.action_stats).toHaveLength(2);
    expect(body.data.admin_stats).toHaveLength(1);
    expect(body.data.daily_stats).toHaveLength(2);
    expect(body.days).toBe(30);
  });

  it('days パラメータでデフォルト30日が使われる', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getAuditLogStats).mockResolvedValue(mockStats);

    const app = createApp();
    await app.request(makeRequest('/api/admin/audit-logs/stats'), undefined, mockEnv);

    expect(getAuditLogStats).toHaveBeenCalledWith(mockEnv.DB, 30);
  });

  it('days=7 を指定できる', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getAuditLogStats).mockResolvedValue(mockStats);

    const app = createApp();
    const res = await app.request(makeRequest('/api/admin/audit-logs/stats?days=7'), undefined, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json() as { data: typeof mockStats; days: number };
    expect(body.days).toBe(7);
    expect(getAuditLogStats).toHaveBeenCalledWith(mockEnv.DB, 7);
  });

  it('days が範囲外（999）の場合は 400 を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);

    const app = createApp();
    const res = await app.request(makeRequest('/api/admin/audit-logs/stats?days=999'), undefined, mockEnv);

    expect(res.status).toBe(400);
    expect(getAuditLogStats).not.toHaveBeenCalled();
  });

  it('days が範囲外（0）の場合は 400 を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);

    const app = createApp();
    const res = await app.request(makeRequest('/api/admin/audit-logs/stats?days=0'), undefined, mockEnv);

    expect(res.status).toBe(400);
    expect(getAuditLogStats).not.toHaveBeenCalled();
  });

  it('不正な days（文字列）の場合は 400 を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);

    const app = createApp();
    const res = await app.request(makeRequest('/api/admin/audit-logs/stats?days=abc'), undefined, mockEnv);

    expect(res.status).toBe(400);
    expect(getAuditLogStats).not.toHaveBeenCalled();
  });

  it('一般ユーザーは 403 を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);

    const app = createApp();
    const res = await app.request(makeRequest('/api/admin/audit-logs/stats'), undefined, mockEnv);

    expect(res.status).toBe(403);
  });

  it('未認証は 401 を返す', async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error('Unauthorized'));

    const app = createApp();
    const res = await app.request(makeRequest('/api/admin/audit-logs/stats', { withAuth: false }), undefined, mockEnv);

    expect(res.status).toBe(401);
  });
});
