import { Hono } from 'hono';
import { fetchWithAuth, parsePagination, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/login-history
app.get('/', async (c) => {
  const limitRaw = c.req.query('limit');
  const offsetRaw = c.req.query('offset');
  const pagination = parsePagination(
    { limit: limitRaw, offset: offsetRaw },
    { defaultLimit: 20, maxLimit: 100 }
  );
  if ('error' in pagination) {
    return c.json({ error: { code: 'BAD_REQUEST', message: pagination.error } }, 400);
  }
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/me/login-history`);
  if (limitRaw !== undefined) url.searchParams.set('limit', String(pagination.limit));
  if (offsetRaw !== undefined) url.searchParams.set('offset', String(pagination.offset));
  const provider = c.req.query('provider');
  if (provider) url.searchParams.set('provider', provider);
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

export default app;
