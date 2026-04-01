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

    // EXTRA_BFF_ORIGINS（カンマ区切り）を許可オリジンに追加
    if (c.env.EXTRA_BFF_ORIGINS) {
      for (const extra of c.env.EXTRA_BFF_ORIGINS.split(',')) {
        const trimmed = extra.trim();
        if (trimmed) {
          try {
            const url = new URL(trimmed);
            allowedOrigins.add(url.origin);
          } catch {
            // 不正なURLは無視
          }
        }
      }
    }

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
