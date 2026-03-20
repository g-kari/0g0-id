import { Hono } from 'hono';
import { fetchWithAuth, proxyResponse } from '@0g0-id/shared';
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

// GET /api/users/:id/login-history
app.get('/:id/login-history', async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/login-history`);
  url.searchParams.set('limit', c.req.query('limit') ?? '20');
  url.searchParams.set('offset', c.req.query('offset') ?? '0');
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

// PATCH /api/users/:id/role
app.patch('/:id/role', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400);
  }

  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/${c.req.param('id')}/role`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Origin: c.env.IDP_ORIGIN,
      },
      body: JSON.stringify(body),
    }
  );
  return proxyResponse(res);
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
