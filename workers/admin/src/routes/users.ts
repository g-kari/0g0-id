import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

function getSession(cookie: string | undefined): { access_token: string } | null {
  if (!cookie) return null;
  try {
    return JSON.parse(atob(cookie));
  } catch {
    return null;
  }
}

// GET /api/users
app.get('/', async (c) => {
  const session = getSession(getCookie(c, SESSION_COOKIE));
  if (!session) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);

  const limit = c.req.query('limit') ?? '50';
  const offset = c.req.query('offset') ?? '0';
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users`);
  url.searchParams.set('limit', limit);
  url.searchParams.set('offset', offset);

  const res = await c.env.IDP.fetch(
    new Request(url.toString(), {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
  );
  return c.json(await res.json(), res.status as 200);
});

export default app;
