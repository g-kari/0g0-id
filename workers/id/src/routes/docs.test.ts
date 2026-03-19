import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { IdpEnv } from '@0g0-id/shared';

import docsRoutes from './docs';

const baseUrl = 'https://id.0g0.xyz';

function buildApp() {
  const app = new Hono<{ Bindings: IdpEnv }>();
  app.route('/docs', docsRoutes);
  return app;
}

describe('GET /docs — ドキュメントルート', () => {
  const app = buildApp();

  describe('GET / — IdP開発者向けドキュメント', () => {
    it('200を返す', async () => {
      const res = await app.request(new Request(`${baseUrl}/docs`));
      expect(res.status).toBe(200);
    });

    it('HTMLコンテンツを返す', async () => {
      const res = await app.request(new Request(`${baseUrl}/docs`));
      const contentType = res.headers.get('Content-Type');
      expect(contentType).toContain('text/html');
    });

    it('APIタイトルがHTMLに含まれる', async () => {
      const res = await app.request(new Request(`${baseUrl}/docs`));
      const html = await res.text();
      expect(html).toContain('0g0 ID API');
    });
  });

  describe('GET /openapi.json — 内部API仕様', () => {
    it('200を返す', async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/openapi.json`));
      expect(res.status).toBe(200);
    });

    it('JSONコンテンツを返す', async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/openapi.json`));
      const contentType = res.headers.get('Content-Type');
      expect(contentType).toContain('application/json');
    });

    it('OpenAPI仕様のopenapi・info・pathsフィールドを含む', async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/openapi.json`));
      const body = await res.json<{ openapi: string; info: { title: string }; paths: unknown }>();
      expect(body.openapi).toMatch(/^3\./);
      expect(body.info.title).toBeTruthy();
      expect(body.paths).toBeTruthy();
    });
  });

  describe('GET /external — 外部連携サービス向けドキュメント', () => {
    it('200を返す', async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external`));
      expect(res.status).toBe(200);
    });

    it('HTMLコンテンツを返す', async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external`));
      const contentType = res.headers.get('Content-Type');
      expect(contentType).toContain('text/html');
    });

    it('外部連携向けタイトルがHTMLに含まれる', async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external`));
      const html = await res.text();
      expect(html).toContain('0g0 ID API');
    });
  });

  describe('GET /external/openapi.json — 外部API仕様', () => {
    it('200を返す', async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external/openapi.json`));
      expect(res.status).toBe(200);
    });

    it('JSONコンテンツを返す', async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external/openapi.json`));
      const contentType = res.headers.get('Content-Type');
      expect(contentType).toContain('application/json');
    });

    it('OpenAPI仕様のopenapi・info・pathsフィールドを含む', async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external/openapi.json`));
      const body = await res.json<{ openapi: string; info: { title: string }; paths: unknown }>();
      expect(body.openapi).toMatch(/^3\./);
      expect(body.info.title).toBeTruthy();
      expect(body.paths).toBeTruthy();
    });
  });
});
