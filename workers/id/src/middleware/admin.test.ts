import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPayload } from '@0g0-id/shared';

vi.mock('@0g0-id/shared', () => ({
  findUserById: vi.fn().mockResolvedValue({ id: 'admin-1', email: 'admin@example.com', role: 'admin', banned_at: null }),
  isAccessTokenRevoked: vi.fn().mockResolvedValue(false),
}));

import { adminMiddleware } from './admin';
import { findUserById, isAccessTokenRevoked } from '@0g0-id/shared';

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

const mockEnv = {
  DB: {} as D1Database,
  JWT_PUBLIC_KEY: 'mock-public-key',
  IDP_ORIGIN: 'https://id.0g0.xyz',
  USER_ORIGIN: 'https://user.0g0.xyz',
  ADMIN_ORIGIN: 'https://admin.0g0.xyz',
};

function buildApp(user?: TokenPayload) {
  const app = new Hono<{ Bindings: typeof mockEnv; Variables: AdminVariables }>();
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
  beforeEach(() => {
    vi.mocked(findUserById).mockResolvedValue({ id: 'admin-1', email: 'admin@example.com', role: 'admin', banned_at: null } as never);
    vi.mocked(isAccessTokenRevoked).mockResolvedValue(false);
  });

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
    const res = await app.request('https://id.0g0.xyz/admin/resource', undefined, mockEnv);
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

  it('jti が未設定のトークン → 401を返す', async () => {
    const noJtiPayload = { ...mockAdminPayload, jti: undefined } as unknown as TokenPayload;
    const app = buildApp(noJtiPayload);
    const res = await app.request('https://id.0g0.xyz/admin/resource', undefined, mockEnv);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('失効済みトークン (isAccessTokenRevoked=true) → 401を返す', async () => {
    vi.mocked(isAccessTokenRevoked).mockResolvedValue(true);
    const app = buildApp(mockAdminPayload);
    const res = await app.request('https://id.0g0.xyz/admin/resource', undefined, mockEnv);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('BAN済み管理者 (banned_at != null) → 401を返す', async () => {
    vi.mocked(findUserById).mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      role: 'admin',
      banned_at: '2024-01-01T00:00:00Z',
    } as never);
    const app = buildApp(mockAdminPayload);
    const res = await app.request('https://id.0g0.xyz/admin/resource', undefined, mockEnv);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('findUserById が null (ユーザー未存在) → 401を返す', async () => {
    vi.mocked(findUserById).mockResolvedValue(null as never);
    const app = buildApp(mockAdminPayload);
    const res = await app.request('https://id.0g0.xyz/admin/resource', undefined, mockEnv);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});
