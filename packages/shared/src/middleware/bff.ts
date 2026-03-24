import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import type { BffEnv } from '../types';

/**
 * BFF共通CORSミドルウェア
 *
 * BFF自身のドメインからのリクエストのみを許可する。
 * user/admin 両 BFF で共有。
 */
export const bffCorsMiddleware = createMiddleware<{ Bindings: BffEnv }>(async (c, next) => {
  const appOrigin = new URL(c.req.url).origin;
  return cors({
    origin: appOrigin,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    credentials: true,
  })(c, next);
});

/**
 * BFF共通CSRFミドルウェア
 *
 * 外部サービスからの直接アクセスを防ぐため、
 * Originヘッダーが BFF 自身のドメインと一致することを検証する。
 * user/admin 両 BFF で共有。
 */
export const bffCsrfMiddleware = createMiddleware<{ Bindings: BffEnv }>(async (c, next) => {
  const origin = c.req.header('Origin') ?? c.req.header('Referer');

  if (!origin) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Origin header required' } }, 403);
  }

  const appOrigin = new URL(c.req.url).origin;

  let originBase: string;
  try {
    const originUrl = new URL(origin);
    originBase = `${originUrl.protocol}//${originUrl.host}`;
  } catch {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Invalid Origin header' } }, 403);
  }

  if (originBase !== appOrigin) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access from external services is not allowed' } }, 403);
  }

  await next();
});
