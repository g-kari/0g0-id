import { createMiddleware } from 'hono/factory';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';

type AdminVariables = {
  user: TokenPayload;
};

export const adminMiddleware = createMiddleware<{
  Bindings: IdpEnv;
  Variables: AdminVariables;
}>(async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, 403);
  }
  await next();
});
