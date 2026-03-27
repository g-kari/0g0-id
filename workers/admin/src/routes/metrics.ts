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


// GET /api/metrics/services — サービス別アクティブトークン統計
app.get('/services', async (c) => {
  const res = await fetchWithAuth(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/metrics/services`);
  return proxyResponse(res);
});

// GET /api/metrics/suspicious-logins?hours=24&min_countries=2
app.get('/suspicious-logins', async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/metrics/suspicious-logins`);
  const hours = c.req.query('hours');
  const minCountries = c.req.query('min_countries');
  if (hours) url.searchParams.set('hours', hours);
  if (minCountries) url.searchParams.set('min_countries', minCountries);
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

// GET /api/metrics/user-registrations?days=30 — 日別新規ユーザー登録数
app.get('/user-registrations', async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/metrics/user-registrations`);
  const days = c.req.query('days');
  if (days) url.searchParams.set('days', days);
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

export default app;
