import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

import profileRoutes from './profile';

const SESSION_COOKIE = '__Host-user-session';
const baseUrl = 'https://user.0g0.xyz';

function makeSessionCookie(): string {
  const session = {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    user: { id: 'user-123', email: 'user@example.com', name: 'Test User', role: 'user' },
  };
  return btoa(encodeURIComponent(JSON.stringify(session)));
}

function buildApp(idpFetch: (req: Request) => Promise<Response>) {
  const app = new Hono<{
    Bindings: { IDP: { fetch: typeof idpFetch }; IDP_ORIGIN: string };
  }>();
  app.route('/api/me', profileRoutes);
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
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof userData }>();
      expect(body.data.id).toBe('user-123');
    });

    it('IdPの /api/users/me エンドポイントを呼び出す', async () => {
      const idpFetch = mockIdp(200, { data: {} });
      const app = buildApp(idpFetch);

      await app.request('/api/me', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/me');
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('IdPが500を返した場合はそのまま伝播する', async () => {
      const idpFetch = mockIdp(500, { error: { code: 'INTERNAL_ERROR' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me', {
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
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
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
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
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
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
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
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
          Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}`,
        },
        body: JSON.stringify({ name: '' }),
      });

      expect(res.status).toBe(400);
    });
  });
});
