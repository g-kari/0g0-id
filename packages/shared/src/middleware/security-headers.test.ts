import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { securityHeaders } from './security-headers';

function buildApp() {
  const app = new Hono();
  app.use('*', securityHeaders());
  app.get('/test', (c) => c.json({ ok: true }));
  return app;
}

describe('securityHeaders', () => {
  const app = buildApp();

  it('X-Frame-Options: SAMEORIGINが設定される', async () => {
    const res = await app.request('https://example.com/test');
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
  });

  it('X-Content-Type-Options: nosniffが設定される', async () => {
    const res = await app.request('https://example.com/test');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('Referrer-Policy: strict-origin-when-cross-originが設定される', async () => {
    const res = await app.request('https://example.com/test');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('X-Permitted-Cross-Domain-Policies: noneが設定される', async () => {
    const res = await app.request('https://example.com/test');
    expect(res.headers.get('X-Permitted-Cross-Domain-Policies')).toBe('none');
  });

  it('Permissions-Policyが設定される', async () => {
    const res = await app.request('https://example.com/test');
    const permissionsPolicy = res.headers.get('Permissions-Policy') ?? '';
    expect(permissionsPolicy).toContain('geolocation=()');
    expect(permissionsPolicy).toContain('microphone=()');
    expect(permissionsPolicy).toContain('camera=()');
  });

  it("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'が設定される", async () => {
    const res = await app.request('https://example.com/test');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it('レスポンスボディへの影響なし', async () => {
    const res = await app.request('https://example.com/test');
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  it('Strict-Transport-Security: max-age=31536000; includeSubDomainsが設定される', async () => {
    const res = await app.request('https://example.com/test');
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
  });

  it('Strict-Transport-SecurityにpreloadディレクティブがつくVersion2', async () => {
    const res = await app.request('https://example.com/test');
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
  });

  it('Permissions-Policyにpayment, usb等の追加APIが無効化される', async () => {
    const res = await app.request('https://example.com/test');
    const permissionsPolicy = res.headers.get('Permissions-Policy') ?? '';
    expect(permissionsPolicy).toContain('payment=()');
    expect(permissionsPolicy).toContain('usb=()');
    expect(permissionsPolicy).toContain('bluetooth=()');
    expect(permissionsPolicy).toContain('display-capture=()');
    expect(permissionsPolicy).toContain('screen-wake-lock=()');
  });

  it('Cross-Origin-Opener-Policy: same-originが設定される', async () => {
    const res = await app.request('https://example.com/test');
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });

  it('Cache-Control: no-storeが設定される（RFC 6749 OAuth 2.0 必須要件）', async () => {
    const res = await app.request('https://example.com/test');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('c.json() で明示的に Cache-Control を指定した場合はオーバーライドされる', async () => {
    const overrideApp = new Hono();
    overrideApp.use('*', securityHeaders());
    overrideApp.get('/cacheable', (c) =>
      c.json({ ok: true }, 200, { 'Cache-Control': 'public, max-age=3600' })
    );
    const res = await overrideApp.request('https://example.com/cacheable');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });
});
