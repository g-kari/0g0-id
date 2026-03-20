import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { fetchWithAuth, fetchWithJsonBody, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/me
app.get('/', async (c) => {
  const res = await fetchWithAuth(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/me`);
  return proxyResponse(res);
});

// GET /api/me/login-history
app.get('/login-history', async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/me/login-history`);
  url.searchParams.set('limit', c.req.query('limit') ?? '20');
  url.searchParams.set('offset', c.req.query('offset') ?? '0');
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

// PATCH /api/me
app.patch('/', async (c) => {
  return fetchWithJsonBody(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/me`, 'PATCH');
});

// DELETE /api/me — アカウント削除（セッションCookieも削除）
app.delete('/', async (c) => {
  const res = await fetchWithAuth(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/me`, {
    method: 'DELETE',
    headers: { Origin: c.env.IDP_ORIGIN },
  });
  if (res.status === 204) {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return c.body(null, 204);
  }
  return proxyResponse(res);
});

export default app;
