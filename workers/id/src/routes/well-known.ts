import { Hono } from 'hono';
import { getJWTKeys, getJWKS } from '@0g0-id/shared';
import type { IdpEnv } from '@0g0-id/shared';

const app = new Hono<{ Bindings: IdpEnv }>();

app.get('/jwks.json', async (c) => {
  const { kid } = await getJWTKeys(c.env.JWT_PRIVATE_KEY, c.env.JWT_PUBLIC_KEY);
  const jwks = await getJWKS(c.env.JWT_PUBLIC_KEY, kid);
  return c.json(jwks, 200, {
    'Cache-Control': 'public, max-age=3600',
  });
});

export default app;
