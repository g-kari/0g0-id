import { describe, it, expect, vi } from 'vitest';
import { encodeSession } from '@0g0-id/shared';
import { Hono } from 'hono';

import sessionsRoutes from './sessions';

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
  app.route('/api/me/sessions', sessionsRoutes);
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

describe('user BFF — /api/me/sessions', () => {
  describe('GET / — アクティブセッション一覧', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/sessions');

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('セッションありでIdPへGETしてセッション一覧を返す', async () => {
      const mockSessions = [
        { id: 'token-1', service_id: null, service_name: null, created_at: '2024-01-01T00:00:00Z', expires_at: '2025-12-31T23:59:59Z' },
      ];
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: mockSessions }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/sessions', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: unknown[] }>();
      expect(body.data).toHaveLength(1);
    });

    it('IdPの /api/users/me/tokens エンドポイントをGETで呼び出す', async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe('GET');
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/me/tokens');
    });

    it('AuthorizationヘッダーにアクセストークンをBearerで付与する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions', {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });
  });

  describe('DELETE /:sessionId — 特定セッションのみログアウト', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/sessions/token-abc', { method: 'DELETE' });

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('セッションありでIdPへDELETEして204を返す', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/sessions/token-abc', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);
    });

    it('IdPの /api/users/me/tokens/:tokenId エンドポイントをDELETEで呼び出す', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions/token-abc', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe('DELETE');
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/me/tokens/token-abc');
    });

    it('AuthorizationヘッダーにアクセストークンをBearerで付与する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions/token-abc', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('OriginヘッダーをIdPのoriginに設定して送信する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions/token-abc', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get('Origin')).toBe('https://id.0g0.xyz');
    });

    it('IdPが404を返した場合はそのまま伝播する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Session not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/sessions/no-such-token', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /others — 現在のセッション以外の全セッションを終了', () => {
    it('セッションなしで401を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/sessions/others', { method: 'DELETE' });

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it('セッションありでIdPへDELETEして他セッションを終了する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request('/api/me/sessions/others', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);
    });

    it('IdPの /api/users/me/tokens/others エンドポイントをDELETEで呼び出す', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions/others', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe('DELETE');
      expect(calledReq.url).toBe('https://id.0g0.xyz/api/users/me/tokens/others');
    });

    it('リクエストボディに token_hash（SHA256(refresh_token)）を含める', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions/others', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const body = await calledReq.json<{ token_hash: string }>();
      // SHA256('mock-refresh-token') の hex 文字列（64文字）が送られることを確認
      expect(typeof body.token_hash).toBe('string');
      expect(body.token_hash).toHaveLength(64);
      expect(body.token_hash).toMatch(/^[0-9a-f]+$/);
    });

    it('Content-Type: application/json ヘッダーを付与してIdPに送信する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions/others', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get('Content-Type')).toBe('application/json');
    });

    it('AuthorizationヘッダーにアクセストークンをBearerで付与する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions/others', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('OriginヘッダーをIdPのoriginに設定して送信する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions/others', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
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

      const res = await app.request('/api/me/sessions/others', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });

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
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);
    });

    it('IdPの /api/users/me/tokens エンドポイントをDELETEで呼び出す', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
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
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get('Authorization')).toBe('Bearer mock-access-token');
    });

    it('OriginヘッダーをIdPのoriginに設定して送信する', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request('/api/me/sessions', {
        method: 'DELETE',
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
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
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });
});
