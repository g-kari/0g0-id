import { Hono } from 'hono';
import { fetchWithAuth, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// DELETE /api/me/sessions — 全デバイスからログアウト（全リフレッシュトークン無効化）
app.delete('/', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/tokens`,
    {
      method: 'DELETE',
      headers: { Origin: c.env.IDP_ORIGIN },
    }
  );
  return proxyResponse(res);
});

export default app;
