import { createMiddleware } from 'hono/factory';
import type { BffEnv } from '@0g0-id/shared';

/**
 * 管理画面API用CSRFミドルウェア
 *
 * 外部サービスからの直接アクセスを防ぐため、
 * Originヘッダーが管理画面ドメインと一致することを検証する。
 */
export const adminCsrfMiddleware = createMiddleware<{ Bindings: BffEnv }>(async (c, next) => {
  const origin = c.req.header('Origin') ?? c.req.header('Referer');

  if (!origin) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Origin header required' } }, 403);
  }

  // リクエスト先のオリジン（管理画面自身のドメイン）
  const adminOrigin = new URL(c.req.url).origin;

  let originBase: string;
  try {
    const originUrl = new URL(origin);
    originBase = `${originUrl.protocol}//${originUrl.host}`;
  } catch {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Invalid Origin header' } }, 403);
  }

  if (originBase !== adminOrigin) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access from external services is not allowed' } }, 403);
  }

  await next();
});
