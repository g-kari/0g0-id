import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import oauthRoutes from './oauth';

const baseUrl = 'https://user.0g0.xyz';

function buildApp() {
  const app = new Hono<{ Bindings: { IDP_ORIGIN: string } }>();
  app.route('/', oauthRoutes);
  return {
    request: (path: string, init?: RequestInit) => {
      const req = new Request(`${baseUrl}${path}`, init);
      return app.request(req, undefined, {
        IDP_ORIGIN: 'https://id.0g0.xyz',
      });
    },
  };
}

const REQUIRED_PARAMS =
  '?client_id=client123&redirect_uri=https://app.example.com/callback&state=abc&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('OAuth ログインページ — GET /login', () => {
  describe('正常系', () => {
    it('必須パラメータがすべて揃っている場合に200を返す', async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      expect(res.status).toBe(200);
    });

    it('レスポンスがHTMLである', async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      expect(res.headers.get('Content-Type')).toContain('text/html');
    });

    it('CSPヘッダーに style-src self が含まれる（外部CSS読み込み許可）', async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      const csp = res.headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("style-src 'self'");
    });

    it('CSPヘッダーに img-src self が含まれる（ファビコン読み込み許可）', async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      const csp = res.headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("img-src 'self'");
    });

    it('CSPヘッダーに unsafe-inline が含まれない', async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      const csp = res.headers.get('Content-Security-Policy') ?? '';
      expect(csp).not.toContain("'unsafe-inline'");
    });

    it('CSPヘッダーに frame-ancestors none が含まれる', async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      const csp = res.headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it('HTMLにIdP /auth/login へのリンクが含まれる', async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      const html = await res.text();
      expect(html).toContain('https://id.0g0.xyz/auth/login');
    });

    it('全プロバイダーのボタンが含まれる', async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      const html = await res.text();
      expect(html).toContain('provider=google');
      expect(html).toContain('provider=line');
      expect(html).toContain('provider=twitch');
      expect(html).toContain('provider=github');
      expect(html).toContain('provider=x');
    });

    it('nonce パラメータがリンクに引き継がれる', async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}&nonce=test-nonce-value`);
      const html = await res.text();
      expect(html).toContain('nonce=test-nonce-value');
    });

    it('scope パラメータがリンクに引き継がれる', async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}&scope=openid+profile`);
      const html = await res.text();
      expect(html).toContain('scope=');
    });
  });

  describe('バリデーション（パラメータ不足）', () => {
    it('client_id が未指定の場合はルートへリダイレクト', async () => {
      const app = buildApp();
      const res = await app.request(
        '/login?redirect_uri=https://app.example.com/callback&state=abc&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/');
    });

    it('redirect_uri が未指定の場合はルートへリダイレクト', async () => {
      const app = buildApp();
      const res = await app.request(
        '/login?client_id=client123&state=abc&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/');
    });

    it('state が未指定の場合はルートへリダイレクト', async () => {
      const app = buildApp();
      const res = await app.request(
        '/login?client_id=client123&redirect_uri=https://app.example.com/callback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/');
    });

    it('code_challenge が未指定の場合はルートへリダイレクト', async () => {
      const app = buildApp();
      const res = await app.request(
        '/login?client_id=client123&redirect_uri=https://app.example.com/callback&state=abc'
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/');
    });
  });

  describe('セキュリティ — HTMLエスケープ', () => {
    it('redirect_uri の特殊文字がHTMLにそのまま出力されない（URLエンコードされる）', async () => {
      const app = buildApp();
      const malicious = 'https://app.example.com/callback?foo=<script>alert(1)</script>';
      const res = await app.request(
        `/login?client_id=client123&redirect_uri=${encodeURIComponent(malicious)}&state=abc&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`
      );
      const html = await res.text();
      // URL APIが <> を %3C%3E にエンコード、escapeHtmlが & を &amp; に変換するため
      // リテラルの <script> タグはHTMLに含まれない
      expect(html).not.toContain('<script>');
      expect(html).toContain('%3Cscript%3E');
    });

    it('state の特殊文字がHTMLエスケープされる', async () => {
      const app = buildApp();
      const maliciousState = '"><img src=x onerror=alert(1)>';
      const res = await app.request(
        `/login?client_id=client123&redirect_uri=https://app.example.com/callback&state=${encodeURIComponent(maliciousState)}&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`
      );
      const html = await res.text();
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
    });
  });
});
