import { Hono } from 'hono';
import { fetchWithAuth, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/metrics
app.get('/', async (c) => {
  const res = await fetchWithAuth(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/metrics`);
  return proxyResponse(res);
});

// GET /api/metrics/login-trends?days=30
app.get('/login-trends', async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/metrics/login-trends`);
  const days = c.req.query('days');
  if (days) url.searchParams.set('days', days);
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

export default app;
