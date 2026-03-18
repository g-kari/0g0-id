import { createMiddleware } from 'hono/factory';
import type { IdpEnv } from '@0g0-id/shared';

const ALLOWED_ORIGINS = new Set<string>();

export const csrfMiddleware = createMiddleware<{ Bindings: IdpEnv }>(async (c, next) => {
  const origin = c.req.header('Origin') ?? c.req.header('Referer');
  if (!origin) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Origin header required' } }, 403);
  }

  // 許可オリジンの構築（初回のみ）
  if (ALLOWED_ORIGINS.size === 0) {
    ALLOWED_ORIGINS.add(c.env.IDP_ORIGIN);
    ALLOWED_ORIGINS.add(c.env.USER_ORIGIN);
    ALLOWED_ORIGINS.add(c.env.ADMIN_ORIGIN);
  }

  const originUrl = new URL(origin);
  const originBase = `${originUrl.protocol}//${originUrl.host}`;

  if (!ALLOWED_ORIGINS.has(originBase)) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Invalid origin' } }, 403);
  }

  await next();
});
