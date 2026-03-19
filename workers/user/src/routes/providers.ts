import { Hono } from 'hono';
import { fetchWithAuth, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/providers — 連携済みSNSプロバイダー一覧
app.get('/', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/providers`
  );
  return proxyResponse(res);
});

// DELETE /api/providers/:provider — SNSプロバイダー連携解除
app.delete('/:provider', async (c) => {
  const provider = c.req.param('provider');
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/providers/${provider}`,
    {
      method: 'DELETE',
      headers: { Origin: c.env.IDP_ORIGIN },
    }
  );
  return proxyResponse(res);
});

export default app;
