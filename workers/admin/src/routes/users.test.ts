import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

import usersRoutes from './users';

const SESSION_COOKIE = '__Host-admin-session';
const baseUrl = 'https://admin.0g0.xyz';

// 管理者セッションCookieを生成するヘルパー
function makeSessionCookie(role: 'admin' | 'user' = 'admin'): string {
  const session = {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    user: { id: 'admin-user-id', email: 'admin@example.com', name: 'Admin', role },
  };
  return btoa(encodeURIComponent(JSON.stringify(session)));
}

function buildApp(idpFetch: (req: Request) => Promise<Response>) {
  const app = new Hono<{
    Bindings: { IDP: { fetch: typeof idpFetch }; IDP_ORIGIN: string };
  }>();
  app.route('/api/users', usersRoutes);
  return {
    request: (path: string, init?: RequestInit) => {
      const req = new Request(`${baseUrl}${path}`, init);
      return app.request(req, undefined, {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: 'https://id.0g0.xyz',
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

const mockUserList = [
  {
    id: 'user-1',
    email: 'user1@example.com',
    name: 'User One',
    role: 'user',
    created_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 'user-2',
    email: 'user2@example.com',
    name: 'User Two',
    role: 'admin',
    created_at: '2024-01-02T00:00:00Z',
  },
];

describe('admin BFF — /api/users', () => {
  describe('GET / — ユーザー一覧', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users');
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('管理者セッションでIdPへプロキシしてユーザー一覧を返す', async () => {
      const idpFetch = mockIdp(200, { data: mockUserList, total: 2 });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockUserList; total: number }>();
      expect(body.data).toHaveLength(2);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.pathname).toBe('/api/users');
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.get('offset')).toBe('0');
    });

    it('limit/offsetのクエリパラメータをIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users?limit=10&offset=20', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get('limit')).toBe('10');
      expect(url.searchParams.get('offset')).toBe('20');
    });

    it('デフォルトのlimit=50/offset=0を使用する', async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      await app.request('/api/users', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.get('offset')).toBe('0');
    });

    it('emailフィルタをIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/users?email=test%40example.com', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get('email')).toBe('test@example.com');
    });

    it('roleフィルタをIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/users?role=admin', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get('role')).toBe('admin');
    });

    it('nameフィルタをIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/users?name=Alice', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get('name')).toBe('Alice');
    });

    it('複数フィルタを同時にIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/users?email=test&role=user&name=Alice&limit=10&offset=5', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get('email')).toBe('test');
      expect(url.searchParams.get('role')).toBe('user');
      expect(url.searchParams.get('name')).toBe('Alice');
      expect(url.searchParams.get('limit')).toBe('10');
      expect(url.searchParams.get('offset')).toBe('5');
    });

    it('Authorizationヘッダーにセッションのアクセストークンを付与する', async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      await app.request('/api/users', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('IdPが500を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(500, { error: { code: 'INTERNAL_ERROR' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });

  describe('GET /:id — ユーザー詳細', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1');
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('管理者セッションでIdPへプロキシしてユーザー詳細を返す', async () => {
      const mockUser = { id: 'user-1', email: 'user1@example.com', name: 'User One', role: 'user' };
      const idpFetch = mockIdp(200, { data: mockUser });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockUser }>();
      expect(body.data.id).toBe('user-1');

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/user-1');
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('存在しないIDでIdPが404を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(404, { error: { code: 'NOT_FOUND' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/no-such-user', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /:id/role — ユーザーロール変更', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1/role', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      });

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('不正なJSONで400を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1/role', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
        },
        body: 'not-valid-json',
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('管理者セッションでIdPにPATCHしてロールを変更する', async () => {
      const idpFetch = mockIdp(200, { data: { id: 'user-1', role: 'admin' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1/role', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
        },
        body: JSON.stringify({ role: 'admin' }),
      });

      expect(res.status).toBe(200);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe('PATCH');
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/user-1/role');
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('IDパラメータをIdPのURLに正しく含める', async () => {
      const idpFetch = mockIdp(200, { data: {} });
      const app = buildApp(idpFetch);

      await app.request('/api/users/target-user-xyz/role', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
        },
        body: JSON.stringify({ role: 'user' }),
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/target-user-xyz/role');
    });

    it('IdPが403（自己変更禁止）を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(403, { error: { code: 'SELF_ROLE_CHANGE_FORBIDDEN' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/admin-user-id/role', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
        },
        body: JSON.stringify({ role: 'user' }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /:id — ユーザー削除', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1', { method: 'DELETE' });
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('管理者セッションでIdPにDELETEしてユーザーを削除する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe('DELETE');
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/user-1');
    });

    it('IDパラメータをIdPのURLに正しく含める', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/users/specific-user-abc', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/specific-user-abc');
    });

    it('IdPが409（サービス所有者削除不可）を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(409, { error: { code: 'USER_OWNS_SERVICES' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/service-owner-id', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(409);
    });

    it('Originヘッダーを付与してIdPに送信する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/users/user-1', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get('Origin')).toBe('https://id.0g0.xyz');
    });
  });

  describe('GET /:id/services — ユーザー認可サービス一覧', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1/services');
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('管理者セッションでIdPにGETして認可サービス一覧を返す', async () => {
      const mockConnections = [
        { service_id: 'svc-1', service_name: 'Service One', authorized_at: '2024-01-01T00:00:00Z' },
        { service_id: 'svc-2', service_name: 'Service Two', authorized_at: '2024-01-02T00:00:00Z' },
      ];
      const idpFetch = mockIdp(200, { data: mockConnections });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1/services', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockConnections }>();
      expect(body.data).toHaveLength(2);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/user-1/services');
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('ユーザーIDをIdPのURLに正しく含める', async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      await app.request('/api/users/specific-user-xyz/services', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/specific-user-xyz/services');
    });

    it('IdPが404（ユーザー不在）を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(404, { error: { code: 'NOT_FOUND' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/no-such-user/services', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });

    it('認可サービスが0件の場合も正常に返す', async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-no-services/services', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: unknown[] }>();
      expect(body.data).toHaveLength(0);
    });
  });

  describe('GET /:id/login-history — ユーザーログイン履歴取得', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1/login-history');
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('管理者セッションでIdPにGETしてログイン履歴を返す', async () => {
      const mockEvents = [
        { id: 'evt-1', user_id: 'user-1', ip_address: '1.2.3.4', created_at: '2024-01-01T00:00:00Z' },
      ];
      const idpFetch = mockIdp(200, { data: mockEvents, total: 1 });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1/login-history', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockEvents; total: number }>();
      expect(body.data).toHaveLength(1);
    });

    it('デフォルトのlimit=20/offset=0をIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/users/user-1/login-history', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get('limit')).toBe('20');
      expect(url.searchParams.get('offset')).toBe('0');
      expect(url.pathname).toBe('/api/users/user-1/login-history');
    });

    it('指定したlimit/offsetをIdPに転送する', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/users/user-1/login-history?limit=5&offset=10', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get('limit')).toBe('5');
      expect(url.searchParams.get('offset')).toBe('10');
    });

    it('ユーザーIDをIdPのURLに正しく含める', async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request('/api/users/specific-user-abc/login-history', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).pathname).toBe('/api/users/specific-user-abc/login-history');
    });

    it('IdPが404を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(404, { error: { code: 'NOT_FOUND' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/no-such-user/login-history', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /:id/providers — ユーザーのSNSプロバイダー連携状態', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1/providers');
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('管理者セッションでIdPにGETしてプロバイダー連携状態を返す', async () => {
      const mockProviders = [
        { provider: 'google', connected: true },
        { provider: 'line', connected: false },
        { provider: 'twitch', connected: false },
        { provider: 'github', connected: true },
        { provider: 'x', connected: false },
      ];
      const idpFetch = mockIdp(200, { data: mockProviders });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1/providers', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockProviders }>();
      expect(body.data).toHaveLength(5);
      expect(body.data.find((p) => p.provider === 'google')?.connected).toBe(true);
      expect(body.data.find((p) => p.provider === 'line')?.connected).toBe(false);
    });

    it('ユーザーIDをIdPのURLに正しく含める', async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      await app.request('/api/users/specific-user-xyz/providers', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/specific-user-xyz/providers');
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('IdPが404（ユーザー不在）を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(404, { error: { code: 'NOT_FOUND' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/no-such-user/providers', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /:id/owned-services — ユーザー所有サービス一覧', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1/owned-services');
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('管理者セッションでIdPにGETして所有サービス一覧を返す', async () => {
      const mockServices = [
        { id: 'service-1', name: 'My Service', client_id: 'client-abc', allowed_scopes: ['profile', 'email'], created_at: '2024-01-01T00:00:00Z' },
        { id: 'service-2', name: 'Another Service', client_id: 'client-xyz', allowed_scopes: ['profile'], created_at: '2024-02-01T00:00:00Z' },
      ];
      const idpFetch = mockIdp(200, { data: mockServices });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/user-1/owned-services', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockServices }>();
      expect(body.data).toHaveLength(2);
      expect(body.data[0]).toMatchObject({ id: 'service-1', name: 'My Service' });
    });

    it('ユーザーIDをIdPのURLに正しく含める', async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      await app.request('/api/users/specific-user-xyz/owned-services', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/specific-user-xyz/owned-services');
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('IdPが404（ユーザー不在）を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(404, { error: { code: 'NOT_FOUND' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/users/no-such-user/owned-services', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });
});
