import { createMiddleware } from 'hono/factory';
import { verifyAccessToken } from '@0g0-id/shared';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';

type AuthVariables = {
  user: TokenPayload;
};

export const authMiddleware = createMiddleware<{
  Bindings: IdpEnv;
  Variables: AuthVariables;
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyAccessToken(
      token,
      c.env.JWT_PUBLIC_KEY,
      c.env.IDP_ORIGIN,
      c.env.IDP_ORIGIN
    );
    c.set('user', payload);
    await next();
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }, 401);
  }
});
