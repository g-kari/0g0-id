import { describe, it, expect, vi } from 'vitest';
import { encodeSession } from '@0g0-id/shared';
import { Hono } from 'hono';

import profileRoutes from './profile';

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
  app.route('/api/me', profileRoutes);
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

describe('user BFF — /api/me', () => {
  describe('GET / — プロフィール取得', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me');

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('セッションありでIdPへプロキシしてユーザー情報を返す', async () => {
      const userData = { id: 'user-123', email: 'user@example.com', name: 'Test User', role: 'user' };
      const idpFetch = mockIdp(200, { data: userData });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof userData }>();
      expect(body.data.id).toBe('user-123');
    });

    it('IdPの /api/users/me エンドポイントを呼び出す', async () => {
      const idpFetch = mockIdp(200, { data: {} });
      const app = buildApp(idpFetch);

      await app.request('/api/me', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/me');
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('IdPが500を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(500, { error: { code: 'INTERNAL_ERROR' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });

  describe('PATCH / — プロフィール更新', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      });

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('不正なJSONで400を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: 'not-valid-json',
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('セッションありでIdPにPATCHしてプロフィールを更新する', async () => {
      const updatedUser = { id: 'user-123', name: 'Updated Name', email: 'user@example.com', role: 'user' };
      const idpFetch = mockIdp(200, { data: updatedUser });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ name: 'Updated Name' }),
      });

      expect(res.status).toBe(200);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe('PATCH');
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/me');
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
      expect(calledReq.headers.get('Content-Type')).toBe('application/json');
    });

    it('リクエストボディをそのままIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: {} });
      const app = buildApp(idpFetch);
      const updateBody = { name: 'New Name', email: 'new@example.com' };

      await app.request('/api/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify(updateBody),
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const calledBody = await calledReq.json<typeof updateBody>();
      expect(calledBody).toEqual(updateBody);
    });

    it('IdPが400を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(400, { error: { code: 'VALIDATION_ERROR' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ name: '' }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /login-history — ログイン履歴取得', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/login-history');
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('セッションありでIdPへプロキシしてログイン履歴を返す', async () => {
      const mockEvents = [
        { id: 'evt-1', user_id: 'user-123', ip_address: '1.2.3.4', created_at: '2024-01-01T00:00:00Z' },
      ];
      const idpFetch = mockIdp(200, { data: mockEvents, total: 1 });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/login-history', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockEvents; total: number }>();
      expect(body.data).toHaveLength(1);
    });

    it('IdPの /api/users/me/login-history エンドポイントを呼び出す', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/me/login-history', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).pathname).toBe('/api/users/me/login-history');
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('デフォルトのlimit=20/offset=0をIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/me/login-history', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get('limit')).toBe('20');
      expect(url.searchParams.get('offset')).toBe('0');
    });

    it('指定したlimit/offsetをIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/me/login-history?limit=5&offset=10', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get('limit')).toBe('5');
      expect(url.searchParams.get('offset')).toBe('10');
    });

    it('IdPが500を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(500, { error: { code: 'INTERNAL_ERROR' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/login-history', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });

  describe('DELETE / — アカウント削除', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me', { method: 'DELETE' });

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('セッションありでIdPにDELETEして204を返す', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);
    });

    it('IdPの /api/users/me エンドポイントをDELETEで呼び出す', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe('DELETE');
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/me');
    });

    it('AuthorizationヘッダーにアクセストークンをBearerで付与する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('OriginヘッダーをIdPのoriginに設定して送信する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get('Origin')).toBe('https://id.0g0.xyz');
    });

    it('削除成功時にセッションCookieを削除するSet-Cookieヘッダーを返す', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);
      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).not.toBeNull();
      expect(setCookie).toContain(SESSION_COOKIE);
    });

    it('IdPが409（サービス所有）を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(409, {
        error: { code: 'CONFLICT', message: 'User owns 1 service(s). Transfer ownership before deleting.' },
      });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(409);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('CONFLICT');
    });

    it('IdPが500を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(500, { error: { code: 'INTERNAL_ERROR' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });

  describe('GET /security-summary — セキュリティ概要取得', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/security-summary');

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('セッションありでIdPへプロキシしてセキュリティ概要を返す', async () => {
      const summaryData = {
        data: {
          active_sessions_count: 2,
          connected_services_count: 1,
          linked_providers: ['google'],
          last_login: {
            provider: 'google',
            ip_address: '192.168.1.1',
            created_at: '2024-01-01T00:00:00Z',
          },
          account_created_at: '2023-01-01T00:00:00Z',
        },
      };
      const idpFetch = mockIdp(200, summaryData);
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/security-summary', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<typeof summaryData>();
      expect(body.data.active_sessions_count).toBe(2);
      expect(body.data.linked_providers).toEqual(['google']);
    });

    it('IdPの /api/users/me/security-summary エンドポイントを呼び出す', async () => {
      const idpFetch = mockIdp(200, { data: {} });
      const app = buildApp(idpFetch);

      await app.request('/api/me/security-summary', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/me/security-summary');
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('last_loginがnullの場合も正常にレスポンスを返す', async () => {
      const summaryData = {
        data: {
          active_sessions_count: 0,
          connected_services_count: 0,
          linked_providers: ['github'],
          last_login: null,
          account_created_at: '2023-06-15T12:00:00Z',
        },
      };
      const idpFetch = mockIdp(200, summaryData);
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/security-summary', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<typeof summaryData>();
      expect(body.data.last_login).toBeNull();
    });

    it('IdPが500を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(500, { error: { code: 'INTERNAL_ERROR' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/security-summary', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });
});
