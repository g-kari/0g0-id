import { Hono } from 'hono';
import { fetchWithAuth, proxyMutate, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/me/sessions — アクティブセッション一覧
app.get('/', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/tokens`
  );
  return proxyResponse(res);
});

// DELETE /api/me/sessions/:sessionId — 特定セッションのみログアウト
app.delete('/:sessionId', async (c) => {
  return proxyMutate(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/tokens/${c.req.param('sessionId')}`
  );
});

// DELETE /api/me/sessions — 全デバイスからログアウト（全リフレッシュトークン無効化）
app.delete('/', async (c) => {
  return proxyMutate(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/users/me/tokens`);
});

export default app;
