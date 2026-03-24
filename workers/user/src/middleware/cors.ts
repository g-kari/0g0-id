import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import type { BffEnv } from '@0g0-id/shared';

/**
 * ユーザー画面API用CORSミドルウェア
 *
 * ユーザー画面自身のドメインからのリクエストのみを許可する。
 */
export const userCorsMiddleware = createMiddleware<{ Bindings: BffEnv }>(async (c, next) => {
  const appOrigin = new URL(c.req.url).origin;
  return cors({
    origin: appOrigin,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    credentials: true,
  })(c, next);
});
