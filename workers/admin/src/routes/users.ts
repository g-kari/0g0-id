import { Hono } from 'hono';
import { fetchWithAuth, fetchWithJsonBody, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/users
app.get('/', async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users`);
  url.searchParams.set('limit', c.req.query('limit') ?? '50');
  url.searchParams.set('offset', c.req.query('offset') ?? '0');
  const email = c.req.query('email');
  const role = c.req.query('role');
  const name = c.req.query('name');
  if (email) url.searchParams.set('email', email);
  if (role) url.searchParams.set('role', role);
  if (name) url.searchParams.set('name', name);

  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

// GET /api/users/:id
app.get('/:id', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}`
  );
  return proxyResponse(res);
});

// GET /api/users/:id/owned-services — ユーザーが所有するサービス一覧
app.get('/:id/owned-services', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/owned-services`
  );
  return proxyResponse(res);
});

// GET /api/users/:id/services — ユーザーが認可しているサービス一覧
app.get('/:id/services', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/services`
  );
  return proxyResponse(res);
});

// GET /api/users/:id/providers — ユーザーのSNSプロバイダー連携状態
app.get('/:id/providers', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/providers`
  );
  return proxyResponse(res);
});

// GET /api/users/:id/login-history
app.get('/:id/login-history', async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/login-history`);
  url.searchParams.set('limit', c.req.query('limit') ?? '20');
  url.searchParams.set('offset', c.req.query('offset') ?? '0');
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

// GET /api/users/:id/tokens — ユーザーのアクティブセッション一覧
app.get('/:id/tokens', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/tokens`
  );
  return proxyResponse(res);
});

// DELETE /api/users/:id/tokens — ユーザーの全セッション無効化
app.delete('/:id/tokens', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/tokens`,
    {
      method: 'DELETE',
      headers: { Origin: c.env.IDP_ORIGIN },
    }
  );
  return proxyResponse(res);
});

// PATCH /api/users/:id/role
app.patch('/:id/role', async (c) => {
  return fetchWithJsonBody(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/role`,
    'PATCH'
  );
});

// DELETE /api/users/:id
app.delete('/:id', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}`,
    {
      method: 'DELETE',
      headers: { Origin: c.env.IDP_ORIGIN },
    }
  );
  return proxyResponse(res);
});

export default app;
