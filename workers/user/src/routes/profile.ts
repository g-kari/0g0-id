import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

function getSession(sessionCookie: string | undefined): {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string; name: string; role: string };
} | null {
  if (!sessionCookie) return null;
  try {
    return JSON.parse(atob(sessionCookie));
  } catch {
    return null;
  }
}

// GET /api/me
app.get('/', async (c) => {
  const session = getSession(getCookie(c, SESSION_COOKIE));
  if (!session) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);
  }

  const res = await c.env.IDP.fetch(
    new Request(`${c.env.IDP_ORIGIN}/api/users/me`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
  );

  const data = await res.json();
  return c.json(data, res.status as 200);
});

// PATCH /api/me
app.patch('/', async (c) => {
  const session = getSession(getCookie(c, SESSION_COOKIE));
  if (!session) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  const res = await c.env.IDP.fetch(
    new Request(`${c.env.IDP_ORIGIN}/api/users/me`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        Origin: c.env.IDP_ORIGIN,
      },
      body: JSON.stringify(body),
    })
  );

  const data = await res.json();
  return c.json(data, res.status as 200);
});

export default app;
