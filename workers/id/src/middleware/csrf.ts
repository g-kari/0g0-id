import { createMiddleware } from 'hono/factory';
import type { IdpEnv } from '@0g0-id/shared';

export const csrfMiddleware = createMiddleware<{ Bindings: IdpEnv }>(async (c, next) => {
  const origin = c.req.header('Origin');
  if (!origin) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Origin header required' } }, 403);
  }

  // リクエストごとに env から許可オリジンを構築する（モジュールレベルのキャッシュは使わない）
  // Cloudflare Workers では env バインディングはリクエストごとに渡されるため、
  // モジュールレベルの可変グローバルにキャッシュすると設定変更が反映されないリスクがある
  const allowedOrigins = new Set([c.env.IDP_ORIGIN, c.env.USER_ORIGIN, c.env.ADMIN_ORIGIN]);

  let originBase: string;
  try {
    const originUrl = new URL(origin);
    originBase = `${originUrl.protocol}//${originUrl.host}`;
  } catch {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Invalid origin' } }, 403);
  }

  if (!allowedOrigins.has(originBase)) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Invalid origin' } }, 403);
  }

  await next();
});
