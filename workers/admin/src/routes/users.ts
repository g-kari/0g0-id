import { Hono } from 'hono';
import { fetchWithAuth, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/users
app.get('/', async (c) => {
  const limit = c.req.query('limit') ?? '50';
  const offset = c.req.query('offset') ?? '0';
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users`);
  url.searchParams.set('limit', limit);
  url.searchParams.set('offset', offset);

  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

export default app;
