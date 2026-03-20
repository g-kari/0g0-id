import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

import servicesRoutes from './services';

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
  app.route('/api/services', servicesRoutes);
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

// IDP がレスポンスを返すモック
function mockIdp(status: number, body: unknown): (req: Request) => Promise<Response> {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

const mockServiceList = [
  {
    id: 'service-1',
    name: 'Test Service',
    client_id: 'client-abc',
    allowed_scopes: ['profile', 'email'],
    owner_user_id: 'admin-user-id',
    created_at: '2024-01-01T00:00:00Z',
  },
];

describe('admin BFF — /api/services', () => {
  describe('GET / — サービス一覧', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services');
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('管理者セッションでIdPへプロキシしてサービス一覧を返す', async () => {
      const idpFetch = mockIdp(200, { data: mockServiceList });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockServiceList }>();
      expect(body.data).toHaveLength(1);
      expect(idpFetch).toHaveBeenCalledOnce();

      // IdP への呼び出しURLを確認
      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/services');
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('IdPが500を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(500, { error: { code: 'INTERNAL_ERROR' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });

  describe('GET /:id — サービス取得', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1');
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('管理者セッションでIdPにGETしてサービスを返す', async () => {
      const mockService = { id: 'service-1', name: 'Test Service', client_id: 'client-abc' };
      const idpFetch = mockIdp(200, { data: mockService });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockService }>();
      expect(body.data.id).toBe('service-1');

      const fetchedReq = vi.mocked(idpFetch).mock.calls[0]?.[0] as Request;
      expect(fetchedReq.url).toBe('https://id.0g0.xyz/api/services/service-1');
      expect(fetchedReq.method).toBe('GET');
    });

    it('IdPが404を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(404, { error: { code: 'NOT_FOUND', message: 'Service not found' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/nonexistent', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST / — サービス作成', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Service' }),
      });

      expect(res.status).toBe(401);
    });

    it('不正なJSONで400を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
        },
        body: 'invalid-json',
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('管理者セッションでIdPにPOSTしてサービスを作成する', async () => {
      const created = { id: 'new-svc', name: 'New Service', client_secret: 'secret-xxx' };
      const idpFetch = mockIdp(201, { data: created });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
        },
        body: JSON.stringify({ name: 'New Service' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json<{ data: typeof created }>();
      expect(body.data.name).toBe('New Service');

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe('POST');
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/services');
    });
  });

  describe('PATCH /:id — スコープ更新', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowed_scopes: ['profile'] }),
      });

      expect(res.status).toBe(401);
    });

    it('不正なJSONで400を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
        },
        body: 'not-json',
      });

      expect(res.status).toBe(400);
    });

    it('管理者セッションでIdPにPATCHしてスコープを更新する', async () => {
      const idpFetch = mockIdp(200, { data: { id: 'service-1', allowed_scopes: ['profile'] } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
        },
        body: JSON.stringify({ allowed_scopes: ['profile'] }),
      });

      expect(res.status).toBe(200);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe('PATCH');
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/services/service-1');
    });
  });

  describe('DELETE /:id — サービス削除', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1', { method: 'DELETE' });
      expect(res.status).toBe(401);
    });

    it('管理者セッションでIdPにDELETEしてサービスを削除する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe('DELETE');
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/services/service-1');
    });
  });

  describe('GET /:id/redirect-uris — リダイレクトURI一覧', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1/redirect-uris');
      expect(res.status).toBe(401);
    });

    it('管理者セッションでIdPにGETしてリダイレクトURIを返す', async () => {
      const uris = [{ id: 'uri-1', uri: 'https://app.example.com/callback' }];
      const idpFetch = mockIdp(200, { data: uris });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1/redirect-uris', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof uris }>();
      expect(body.data).toHaveLength(1);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/services/service-1/redirect-uris');
    });
  });

  describe('POST /:id/redirect-uris — リダイレクトURI追加', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1/redirect-uris', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: 'https://app.example.com/callback' }),
      });
      expect(res.status).toBe(401);
    });

    it('不正なJSONで400を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1/redirect-uris', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
        },
        body: 'bad-json',
      });

      expect(res.status).toBe(400);
    });

    it('管理者セッションでIdPにPOSTしてURIを追加する', async () => {
      const idpFetch = mockIdp(201, { data: { id: 'uri-2', uri: 'https://app.example.com/cb' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1/redirect-uris', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
        },
        body: JSON.stringify({ uri: 'https://app.example.com/cb' }),
      });

      expect(res.status).toBe(201);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe('POST');
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/services/service-1/redirect-uris');
    });
  });

  describe('DELETE /:id/redirect-uris/:uriId — リダイレクトURI削除', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1/redirect-uris/uri-1', {
        method: 'DELETE',
      });
      expect(res.status).toBe(401);
    });

    it('管理者セッションでIdPにDELETEしてURIを削除する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request('/api/services/service-1/redirect-uris/uri-1', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe('DELETE');
      expect(calledReq.url).toBe(
        'https://id.0g0.xyz/api/services/service-1/redirect-uris/uri-1'
      );
    });
  });
});
