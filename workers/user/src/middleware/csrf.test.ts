import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { userCsrfMiddleware } from './csrf';

// テスト用のアプリケーション（CSRF保護付き）
function buildApp() {
  const app = new Hono();
  app.use('/api/*', userCsrfMiddleware);
  app.get('/api/test', (c) => c.json({ ok: true }));
  app.post('/api/test', (c) => c.json({ ok: true }));
  return app;
}

describe('userCsrfMiddleware', () => {
  const app = buildApp();
  const baseUrl = 'https://user.0g0.xyz';

  describe('Originヘッダーなし', () => {
    it('GETリクエストでOriginなし → 403を返す', async () => {
      const req = new Request(`${baseUrl}/api/test`);
      const res = await app.request(req);
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('POSTリクエストでOriginなし → 403を返す', async () => {
      const req = new Request(`${baseUrl}/api/test`, { method: 'POST' });
      const res = await app.request(req);
      expect(res.status).toBe(403);
    });
  });

  describe('正常なOriginヘッダー（ユーザー画面ドメイン）', () => {
    it('GETリクエストでOrigin=ユーザー画面ドメイン → 200を返す', async () => {
      const req = new Request(`${baseUrl}/api/test`, {
        headers: { Origin: baseUrl },
      });
      const res = await app.request(req);
      expect(res.status).toBe(200);
    });

    it('POSTリクエストでOrigin=ユーザー画面ドメイン → 200を返す', async () => {
      const req = new Request(`${baseUrl}/api/test`, {
        method: 'POST',
        headers: { Origin: baseUrl },
      });
      const res = await app.request(req);
      expect(res.status).toBe(200);
    });

    it('Refererヘッダーを使った場合も通過する', async () => {
      const req = new Request(`${baseUrl}/api/test`, {
        headers: { Referer: `${baseUrl}/profile.html` },
      });
      const res = await app.request(req);
      expect(res.status).toBe(200);
    });
  });

  describe('外部サービスからのアクセス', () => {
    it('外部ドメインからのOrigin → 403を返す', async () => {
      const req = new Request(`${baseUrl}/api/test`, {
        headers: { Origin: 'https://external-service.example.com' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('idドメインからのOrigin（内部サービスでもユーザーAPIは拒否） → 403を返す', async () => {
      const req = new Request(`${baseUrl}/api/test`, {
        headers: { Origin: 'https://id.0g0.xyz' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(403);
    });

    it('adminドメインからのOrigin → 403を返す', async () => {
      const req = new Request(`${baseUrl}/api/test`, {
        headers: { Origin: 'https://admin.0g0.xyz' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(403);
    });

    it('不正な形式のOriginヘッダー → 403を返す', async () => {
      const req = new Request(`${baseUrl}/api/test`, {
        headers: { Origin: 'not-a-valid-url' },
      });
      const res = await app.request(req);
      expect(res.status).toBe(403);
    });
  });

  describe('/auth/* ルートはCSRF保護対象外', () => {
    it('authルートはOriginなしでもアクセス可能', async () => {
      const authApp = new Hono();
      authApp.use('/api/*', userCsrfMiddleware);
      authApp.get('/auth/login', (c) => c.json({ ok: true }));

      const req = new Request(`${baseUrl}/auth/login`);
      const res = await authApp.request(req);
      // /auth/* はミドルウェア対象外なので通過
      expect(res.status).toBe(200);
    });
  });
});
