import { createMiddleware } from 'hono/factory';
import { findUserById } from '@0g0-id/shared';
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

  // BANされた管理者のアクセスを即座に遮断（JWT有効期限内でも拒否）
  const dbUser = await findUserById(c.env.DB, user.sub);
  if (!dbUser || dbUser.banned_at !== null) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Account suspended or not found' } }, 401);
  }

  await next();
});
