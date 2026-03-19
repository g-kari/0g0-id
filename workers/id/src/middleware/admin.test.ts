import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { TokenPayload } from '@0g0-id/shared';
import { adminMiddleware } from './admin';

type AdminVariables = { user: TokenPayload };

const mockAdminPayload: TokenPayload = {
  sub: 'admin-1',
  email: 'admin@example.com',
  role: 'admin',
  iss: 'https://id.0g0.xyz',
  aud: 'https://id.0g0.xyz',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 900,
  jti: 'jti-admin',
  kid: 'kid-1',
};

const mockUserPayload: TokenPayload = {
  ...mockAdminPayload,
  sub: 'user-1',
  email: 'user@example.com',
  role: 'user',
  jti: 'jti-user',
};

function buildApp(user?: TokenPayload) {
  const app = new Hono<{ Variables: AdminVariables }>();
  if (user) {
    app.use('*', async (c, next) => {
      c.set('user', user);
      await next();
    });
  }
  app.use('/admin/*', adminMiddleware);
  app.get('/admin/resource', (c) => c.json({ ok: true }));
  return app;
}

describe('adminMiddleware', () => {
  it('ユーザー変数が未設定 → 403を返す', async () => {
    const app = buildApp();
    const res = await app.request('https://id.0g0.xyz/admin/resource');
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('role=user の場合 → 403を返す', async () => {
    const app = buildApp(mockUserPayload);
    const res = await app.request('https://id.0g0.xyz/admin/resource');
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('role=admin の場合 → 200を返す', async () => {
    const app = buildApp(mockAdminPayload);
    const res = await app.request('https://id.0g0.xyz/admin/resource');
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  it('admin以外のルートはミドルウェア対象外', async () => {
    const app = buildApp(); // userなし
    app.get('/public/resource', (c) => c.json({ ok: true }));
    const res = await app.request('https://id.0g0.xyz/public/resource');
    expect(res.status).toBe(200);
  });
});
