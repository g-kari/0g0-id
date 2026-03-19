import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@0g0-id/shared', () => ({
  generateToken: vi.fn(),
}));

import { generateToken } from '@0g0-id/shared';
import authRoutes from './auth';

const baseUrl = 'https://admin.0g0.xyz';
const STATE_COOKIE = '__Host-admin-oauth-state';
const SESSION_COOKIE = '__Host-admin-session';

function buildIdpFetch(status: number, body: unknown): (req: Request) => Promise<Response> {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

function buildApp(idpFetch: (req: Request) => Promise<Response> = vi.fn()) {
  const app = new Hono<{
    Bindings: { IDP: { fetch: typeof idpFetch }; IDP_ORIGIN: string };
  }>();
  app.route('/auth', authRoutes);
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(new Request(`${baseUrl}${path}`, init), undefined, {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: 'https://id.0g0.xyz',
      }),
  };
}

// 管理者ユーザーのexchangeレスポンスを生成するヘルパー
function makeExchangeResponse(role: 'admin' | 'user' = 'admin') {
  return {
    data: {
      access_token: 'mock-access-token',
      refresh_token: 'mock-refresh-token',
      user: { id: 'user-1', email: 'admin@example.com', name: 'Admin', role },
    },
  };
}

describe('admin BFF — /auth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateToken).mockReturnValue('mock-state-token');
  });

  // ===== GET /auth/login =====
  describe('GET /auth/login', () => {
    it('stateCookieをセットしてIdPのloginURLへリダイレクトする', async () => {
      const app = buildApp();
      const res = await app.request('/auth/login');

      expect(res.status).toBe(302);
      const location = res.headers.get('location') ?? '';
      expect(location).toContain('https://id.0g0.xyz/auth/login');
      expect(location).toContain('state=mock-state-token');
      expect(location).toContain('redirect_to=');

      // state cookie が設定されていることを確認
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain(STATE_COOKIE);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
    });

    it('redirect_toにコールバックURLが含まれる', async () => {
      const app = buildApp();
      const res = await app.request('/auth/login');

      const location = res.headers.get('location') ?? '';
      expect(location).toContain(encodeURIComponent('/auth/callback'));
    });
  });

  // ===== GET /auth/callback =====
  describe('GET /auth/callback', () => {
    it('codeが未指定 → /?error=missing_paramsにリダイレクト', async () => {
      const app = buildApp();
      const res = await app.request('/auth/callback?state=some-state');

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/?error=missing_params');
    });

    it('stateが未指定 → /?error=missing_paramsにリダイレクト', async () => {
      const app = buildApp();
      const res = await app.request('/auth/callback?code=some-code');

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/?error=missing_params');
    });

    it('stateCookieなし → /?error=missing_sessionにリダイレクト', async () => {
      const app = buildApp();
      const res = await app.request('/auth/callback?code=some-code&state=some-state');

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/?error=missing_session');
    });

    it('stateが不一致 → /?error=state_mismatchにリダイレクト', async () => {
      const app = buildApp();
      const res = await app.request('/auth/callback?code=some-code&state=wrong-state', {
        headers: { Cookie: `${STATE_COOKIE}=correct-state` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/?error=state_mismatch');
    });

    it('IdPのexchangeが失敗 → /?error=exchange_failedにリダイレクト', async () => {
      const idpFetch = buildIdpFetch(400, { error: { code: 'INVALID_CODE' } });
      const app = buildApp(idpFetch);

      const res = await app.request('/auth/callback?code=bad-code&state=mock-state', {
        headers: { Cookie: `${STATE_COOKIE}=mock-state` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/?error=exchange_failed');
    });

    it('管理者以外のユーザー → /?error=not_adminにリダイレクト', async () => {
      const idpFetch = buildIdpFetch(200, makeExchangeResponse('user'));
      const app = buildApp(idpFetch);

      const res = await app.request('/auth/callback?code=valid-code&state=mock-state', {
        headers: { Cookie: `${STATE_COOKIE}=mock-state` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/?error=not_admin');
    });

    it('管理者ユーザー → セッションCookieをセットして/dashboard.htmlにリダイレクト', async () => {
      const idpFetch = buildIdpFetch(200, makeExchangeResponse('admin'));
      const app = buildApp(idpFetch);

      const res = await app.request('/auth/callback?code=valid-code&state=mock-state', {
        headers: { Cookie: `${STATE_COOKIE}=mock-state` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/dashboard.html');

      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain(SESSION_COOKIE);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
    });

    it('stateCookieが削除される（セキュリティ: 再利用防止）', async () => {
      const idpFetch = buildIdpFetch(200, makeExchangeResponse('admin'));
      const app = buildApp(idpFetch);

      const res = await app.request('/auth/callback?code=valid-code&state=mock-state', {
        headers: { Cookie: `${STATE_COOKIE}=mock-state` },
      });

      // set-cookie に state cookie の削除（max-age=0 または expires=past）が含まれる
      const setCookieHeaders: string[] =
        (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie?.() ??
        [res.headers.get('set-cookie') ?? ''];
      const stateDeleteCookie = setCookieHeaders.find((c) => c.startsWith(STATE_COOKIE));
      expect(stateDeleteCookie).toBeDefined();
    });
  });

  // ===== POST /auth/logout =====
  describe('POST /auth/logout', () => {
    it('セッションなし → セッションCookieを削除して/にリダイレクト', async () => {
      const app = buildApp();
      const res = await app.request('/auth/logout', { method: 'POST' });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    });

    it('有効なセッション → IdPにログアウトを通知してセッションCookieを削除', async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      const app = buildApp(idpFetch);

      const sessionData = btoa(
        encodeURIComponent(
          JSON.stringify({
            access_token: 'mock-at',
            refresh_token: 'mock-rt',
            user: { id: 'user-1', email: 'admin@example.com', name: 'Admin', role: 'admin' },
          })
        )
      );

      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: { Cookie: `${SESSION_COOKIE}=${sessionData}` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');

      // IdPにlogoutリクエストが送信されたことを確認
      expect(idpFetch).toHaveBeenCalledOnce();
      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe('https://id.0g0.xyz/auth/logout');
      expect(calledReq.method).toBe('POST');

      // セッションCookieが削除されることを確認
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain(SESSION_COOKIE);
    });

    it('不正なセッションデータ → エラーなく/にリダイレクト（堅牢性）', async () => {
      const app = buildApp();
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: { Cookie: `${SESSION_COOKIE}=invalid-session-data` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    });
  });
});
