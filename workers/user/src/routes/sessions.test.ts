import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

import sessionsRoutes from './sessions';

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
  app.route('/api/me/sessions', sessionsRoutes);
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

describe('user BFF — /api/me/sessions', () => {
  describe('DELETE / — 全デバイスからログアウト', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/sessions', { method: 'DELETE' });

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('セッションありでIdPへDELETEしてトークンを全無効化する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/sessions', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);
    });

    it('IdPの /api/users/me/tokens エンドポイントをDELETEで呼び出す', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe('DELETE');
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/me/tokens');
    });

    it('AuthorizationヘッダーにアクセストークンをBearerで付与する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('OriginヘッダーをIdPのoriginに設定して送信する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get('Origin')).toBe('https://id.0g0.xyz');
    });

    it('IdPが500を返した場合はそのまま伝播する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/sessions', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });
});
