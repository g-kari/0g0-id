import { describe, it, expect, vi } from 'vitest';
import { encodeSession } from '@0g0-id/shared';
import { Hono } from 'hono';

import auditLogsRoutes from './audit-logs';

const SESSION_COOKIE = '__Host-admin-session';
const baseUrl = 'https://admin.0g0.xyz';

async function makeSessionCookie(role: 'admin' | 'user' = 'admin'): Promise<string> {
  const session = {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    user: { id: 'admin-user-id', email: 'admin@example.com', name: 'Admin', role },
  };
  return encodeSession(session, 'test-secret');
}

function buildApp(idpFetch: (req: Request) => Promise<Response>) {
  const app = new Hono<{
    Bindings: { IDP: { fetch: typeof idpFetch }; IDP_ORIGIN: string; SESSION_SECRET: string };
  }>();
  app.route('/api/audit-logs', auditLogsRoutes);
  return {
    request: (path: string, init?: RequestInit) => {
      const req = new Request(`${baseUrl}${path}`, init);
      return app.request(req, undefined, {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: 'https://id.0g0.xyz',
        SESSION_SECRET: 'test-secret',
      });
    },
  };
}

function mockIdp(status: number, body: unknown): (req: Request) => Promise<Response> {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

const mockAuditLogs = [
  {
    id: 'log-1',
    admin_user_id: 'admin-1',
    target_id: 'user-1',
    action: 'ban_user',
    created_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 'log-2',
    admin_user_id: 'admin-2',
    target_id: 'user-2',
    action: 'change_role',
    created_at: '2024-01-02T00:00:00Z',
  },
];

describe('admin BFF — /api/audit-logs', () => {
  describe('GET / — 監査ログ一覧', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/audit-logs');
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('管理者セッションでIdPへプロキシして監査ログを返す', async () => {
      const idpFetch = mockIdp(200, { data: mockAuditLogs, total: 2 });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/audit-logs', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockAuditLogs; total: number }>();
      expect(body.data).toHaveLength(2);
      expect(body.data[0].action).toBe('ban_user');
      expect(idpFetch).toHaveBeenCalledOnce();
    });

    it('IdP への呼び出しURLに /api/admin/audit-logs が含まれる', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/audit-logs', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const calledUrl = vi.mocked(idpFetch).mock.calls[0][0].url;
      expect(calledUrl).toContain('/api/admin/audit-logs');
    });

    it('デフォルトで limit=50, offset=0 をIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/audit-logs', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.searchParams.get('limit')).toBe('50');
      expect(calledUrl.searchParams.get('offset')).toBe('0');
    });

    it('limit・offsetクエリパラメータをIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/audit-logs?limit=10&offset=20', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.searchParams.get('limit')).toBe('10');
      expect(calledUrl.searchParams.get('offset')).toBe('20');
    });

    it('admin_user_idフィルターをIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/audit-logs?admin_user_id=00000000-0000-0000-0000-000000000001', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.searchParams.get('admin_user_id')).toBe('00000000-0000-0000-0000-000000000001');
    });

    it('target_idフィルターをIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/audit-logs?target_id=00000000-0000-0000-0000-000000000002', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.searchParams.get('target_id')).toBe('00000000-0000-0000-0000-000000000002');
    });

    it('actionフィルターをIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/audit-logs?action=user.ban', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.searchParams.get('action')).toBe('user.ban');
    });

    it('複数フィルターを同時にIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/audit-logs?admin_user_id=00000000-0000-0000-0000-000000000001&target_id=00000000-0000-0000-0000-000000000002&action=user.ban', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.searchParams.get('admin_user_id')).toBe('00000000-0000-0000-0000-000000000001');
      expect(calledUrl.searchParams.get('target_id')).toBe('00000000-0000-0000-0000-000000000002');
      expect(calledUrl.searchParams.get('action')).toBe('user.ban');
    });

    it('IdP が404を返した場合は404をプロキシする', async () => {
      const idpFetch = mockIdp(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/audit-logs', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });

    it('IdP が500を返した場合は500をプロキシする', async () => {
      const idpFetch = mockIdp(500, { error: { code: 'INTERNAL_ERROR', message: 'Server error' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/audit-logs', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });
});
