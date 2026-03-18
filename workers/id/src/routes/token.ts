import { Hono } from 'hono';
import { findRefreshTokenByHash, findServiceByClientId, sha256, timingSafeEqual } from '@0g0-id/shared';
import type { IdpEnv } from '@0g0-id/shared';

const app = new Hono<{ Bindings: IdpEnv }>();

// POST /api/token/introspect — RFC 7662 トークンイントロスペクション
app.post('/introspect', async (c) => {
  // Basic認証でサービス認証
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Basic ')) {
    return c.json({ active: false }, 401);
  }

  const credentials = atob(authHeader.slice(6));
  const colonIndex = credentials.indexOf(':');
  if (colonIndex === -1) {
    return c.json({ active: false }, 401);
  }

  const clientId = credentials.slice(0, colonIndex);
  const clientSecret = credentials.slice(colonIndex + 1);

  const service = await findServiceByClientId(c.env.DB, clientId);
  if (!service) {
    return c.json({ active: false }, 401);
  }

  const secretHash = await sha256(clientSecret);
  if (!timingSafeEqual(secretHash, service.client_secret_hash)) {
    return c.json({ active: false }, 401);
  }

  // トークン取得
  let body: { token?: string };
  try {
    body = await c.req.json<{ token?: string }>();
  } catch {
    return c.json({ active: false }, 400);
  }

  if (!body.token) {
    return c.json({ active: false }, 400);
  }

  // リフレッシュトークンの場合
  const tokenHash = await sha256(body.token);
  const refreshToken = await findRefreshTokenByHash(c.env.DB, tokenHash);

  if (refreshToken && refreshToken.revoked_at === null) {
    const isExpired = new Date(refreshToken.expires_at) < new Date();
    return c.json({
      active: !isExpired,
      sub: refreshToken.user_id,
      exp: Math.floor(new Date(refreshToken.expires_at).getTime() / 1000),
    });
  }

  return c.json({ active: false });
});

export default app;
