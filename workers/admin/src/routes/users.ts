import { Hono } from 'hono';
import { fetchWithAuth, fetchWithJsonBody, isValidProvider, parseDays, parsePagination, proxyMutate, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/users
app.get('/', async (c) => {
  const pagination = parsePagination(
    { limit: c.req.query('limit'), offset: c.req.query('offset') },
    { defaultLimit: 50, maxLimit: 100 }
  );
  if ('error' in pagination) {
    return c.json({ error: { code: 'BAD_REQUEST', message: pagination.error } }, 400);
  }
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users`);
  url.searchParams.set('limit', String(pagination.limit));
  url.searchParams.set('offset', String(pagination.offset));
  const email = c.req.query('email');
  const role = c.req.query('role');
  const name = c.req.query('name');
  const banned = c.req.query('banned');
  if (email) url.searchParams.set('email', email);
  if (role) url.searchParams.set('role', role);
  if (name) url.searchParams.set('name', name);
  if (banned === 'true' || banned === 'false') url.searchParams.set('banned', banned);

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
  const pagination = parsePagination(
    { limit: c.req.query('limit'), offset: c.req.query('offset') },
    { defaultLimit: 20, maxLimit: 100 }
  );
  if ('error' in pagination) {
    return c.json({ error: { code: 'BAD_REQUEST', message: pagination.error } }, 400);
  }
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/login-history`);
  url.searchParams.set('limit', String(pagination.limit));
  url.searchParams.set('offset', String(pagination.offset));
  const provider = c.req.query('provider');
  if (provider) {
    if (!isValidProvider(provider)) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid provider' } }, 400);
    }
    url.searchParams.set('provider', provider);
  }
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

// GET /api/users/:id/login-stats — ユーザーのプロバイダー別ログイン統計
app.get('/:id/login-stats', async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/login-stats`);
  const daysResult = parseDays(c.req.query('days'));
  if (daysResult !== undefined) {
    if ('error' in daysResult) {
      return c.json({ error: { code: 'INVALID_PARAMETER', message: daysResult.error } }, 400);
    }
    url.searchParams.set('days', String(daysResult.days));
  }
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

// GET /api/users/:id/login-trends — ユーザーの日別ログイントレンド
app.get('/:id/login-trends', async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/login-trends`);
  const daysResult = parseDays(c.req.query('days'));
  if (daysResult !== undefined) {
    if ('error' in daysResult) {
      return c.json({ error: { code: 'INVALID_PARAMETER', message: daysResult.error } }, 400);
    }
    url.searchParams.set('days', String(daysResult.days));
  }
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

// DELETE /api/users/:id/tokens/:tokenId — ユーザーの特定セッションを失効
app.delete('/:id/tokens/:tokenId', async (c) => {
  return proxyMutate(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/tokens/${c.req.param('tokenId')}`
  );
});

// DELETE /api/users/:id/tokens — ユーザーの全セッション無効化
app.delete('/:id/tokens', async (c) => {
  return proxyMutate(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/tokens`);
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

// PATCH /api/users/:id/ban — ユーザーを停止
app.patch('/:id/ban', async (c) => {
  return proxyMutate(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/ban`, 'PATCH');
});

// DELETE /api/users/:id/ban — ユーザー停止を解除
app.delete('/:id/ban', async (c) => {
  return proxyMutate(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/ban`);
});

// DELETE /api/users/:id
app.delete('/:id', async (c) => {
  return proxyMutate(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}`);
});

export default app;
