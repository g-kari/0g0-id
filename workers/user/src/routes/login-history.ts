import { Hono } from 'hono';
import { fetchWithAuth, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/login-history
app.get('/', async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/me/login-history`);
  const limit = c.req.query('limit');
  const offset = c.req.query('offset');
  if (limit) url.searchParams.set('limit', limit);
  if (offset) url.searchParams.set('offset', offset);

  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

export default app;
