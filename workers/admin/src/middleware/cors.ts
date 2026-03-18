import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import type { BffEnv } from '@0g0-id/shared';

/**
 * 管理画面API用CORSミドルウェア
 *
 * 管理画面自身のドメインからのリクエストのみを許可する。
 */
export const adminCorsMiddleware = createMiddleware<{ Bindings: BffEnv }>(async (c, next) => {
  const appOrigin = new URL(c.req.url).origin;
  return cors({
    origin: appOrigin,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    credentials: true,
  })(c, next);
});
