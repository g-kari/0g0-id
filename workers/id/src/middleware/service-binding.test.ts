import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { IdpEnv } from '@0g0-id/shared';
import { serviceBindingMiddleware } from './service-binding';

function buildApp(env: Partial<IdpEnv>) {
  const app = new Hono<{ Bindings: typeof env }>();
  app.use('/auth/*', serviceBindingMiddleware);
  app.post('/auth/exchange', (c) => c.json({ ok: true }));
  app.post('/auth/refresh', (c) => c.json({ ok: true }));
  return { app, env };
}

const baseUrl = 'https://id.0g0.xyz';
const SECRET = 'test-internal-secret-12345';

describe('serviceBindingMiddleware', () => {
  describe('INTERNAL_SERVICE_SECRET が未設定の場合', () => {
    it('ヘッダーなしでもリクエストを通過させる', async () => {
      const { app, env } = buildApp({});
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, { method: 'POST' }),
        undefined,
        env
      );
      expect(res.status).toBe(200);
    });
  });

  describe('INTERNAL_SERVICE_SECRET が設定されている場合', () => {
    it('正しい X-Internal-Secret ヘッダーで通過する', async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: 'POST',
          headers: { 'X-Internal-Secret': SECRET },
        }),
        undefined,
        env
      );
      expect(res.status).toBe(200);
    });

    it('不正な X-Internal-Secret ヘッダーで403を返す', async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: 'POST',
          headers: { 'X-Internal-Secret': 'wrong-secret' },
        }),
        undefined,
        env
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('ヘッダーなしで403���返す', async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, { method: 'POST' }),
        undefined,
        env
      );
      expect(res.status).toBe(403);
    });

    it('Authorization: Basic ヘッダーがあれば通過する（サービスOAuth）', async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: 'POST',
          headers: { Authorization: 'Basic dGVzdDp0ZXN0' },
        }),
        undefined,
        env
      );
      expect(res.status).toBe(200);
    });

    it('Authorization: Bearer ヘッダーでは通過しない', async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: 'POST',
          headers: { Authorization: 'Bearer some-token' },
        }),
        undefined,
        env
      );
      expect(res.status).toBe(403);
    });

    it('/auth/refresh にも適用される', async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const resBlocked = await app.request(
        new Request(`${baseUrl}/auth/refresh`, { method: 'POST' }),
        undefined,
        env
      );
      expect(resBlocked.status).toBe(403);

      const resAllowed = await app.request(
        new Request(`${baseUrl}/auth/refresh`, {
          method: 'POST',
          headers: { 'X-Internal-Secret': SECRET },
        }),
        undefined,
        env
      );
      expect(resAllowed.status).toBe(200);
    });
  });
});
