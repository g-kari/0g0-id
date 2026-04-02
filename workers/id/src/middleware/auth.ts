import { createMiddleware } from 'hono/factory';
import { verifyAccessToken } from '@0g0-id/shared';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';

type AuthVariables = {
  user: TokenPayload;
};

/**
 * サービストークン（cid付き）を拒否するミドルウェア。
 * /api/users/me 系のBFFセッション専用エンドポイントで使用する。
 * サービストークンは /userinfo のみ許可されるべきで、内部ユーザー管理APIへのアクセスは禁止。
 */
export const rejectServiceTokenMiddleware = createMiddleware<{
  Bindings: IdpEnv;
  Variables: AuthVariables;
}>(async (c, next) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);
  }
  if (user.cid) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Service tokens cannot access this endpoint' } }, 403);
  }
  await next();
});

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
