import { Hono } from 'hono';
import { fetchWithAuth, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/me/security/summary — セキュリティ概要（アクティブセッション数・連携サービス数・最終ログインなど）
app.get('/summary', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/security-summary`,
  );
  return proxyResponse(res);
});

// GET /api/me/security/login-stats — プロバイダー別ログイン統計（days: 1〜90、デフォルト30）
app.get('/login-stats', async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/me/login-stats`);
  const days = c.req.query('days');
  if (days) url.searchParams.set('days', days);
  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

export default app;
