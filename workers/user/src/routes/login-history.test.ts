import { describe, it, expect, vi } from 'vitest';
import { encodeSession } from '@0g0-id/shared';
import { Hono } from 'hono';

import loginHistoryRoutes from './login-history';

const SESSION_COOKIE = '__Host-user-session';
const baseUrl = 'https://user.0g0.xyz';

async function makeSessionCookie(): Promise<string> {
  const session = {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    user: { id: 'user-123', email: 'user@example.com', name: 'Test User', role: 'user' as const },
  };
  return encodeSession(session, 'test-secret');
}

function buildApp(idpFetch: (req: Request) => Promise<Response>) {
  const app = new Hono<{
    Bindings: { IDP: { fetch: typeof idpFetch }; IDP_ORIGIN: string; SESSION_SECRET: string };
  }>();
  app.route('/api/login-history', loginHistoryRoutes);
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

const mockLoginEvents = [
  {
    id: 'event-1',
    user_id: 'user-123',
    provider: 'google',
    ip_address: '127.0.0.1',
    user_agent: 'Mozilla/5.0',
    created_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 'event-2',
    user_id: 'user-123',
    provider: 'github',
    ip_address: '192.168.1.1',
    user_agent: 'Mozilla/5.0',
    created_at: '2024-01-02T00:00:00Z',
  },
];

describe('user BFF — /api/login-history', () => {
  describe('GET / — ログイン履歴取得', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/login-history');

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('セッションありでIdPへプロキシしてログイン履歴を返す', async () => {
      const idpFetch = mockIdp(200, { data: mockLoginEvents, total: 2 });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/login-history', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockLoginEvents; total: number }>();
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('IdPの /api/users/me/login-history エンドポイントを呼び出す', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/login-history', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/me/login-history');
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('limitクエリパラメータをIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/login-history?limit=10', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get('limit')).toBe('10');
    });

    it('offsetクエリパラメータをIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/login-history?offset=20', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get('offset')).toBe('20');
    });

    it('limitとoffsetを同時にIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/login-history?limit=5&offset=10', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get('limit')).toBe('5');
      expect(url.searchParams.get('offset')).toBe('10');
    });

    it('クエリパラメータなしの場合はURLに余分なパラメータを含まない', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/login-history', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.has('limit')).toBe(false);
      expect(url.searchParams.has('offset')).toBe(false);
    });

    it('IdPが400を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(400, { error: { code: 'BAD_REQUEST', message: 'Invalid limit' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/login-history?limit=invalid', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(400);
    });

    it('IdPが500を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(500, { error: { code: 'INTERNAL_ERROR' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/login-history', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });
});
