import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import type { BffEnv } from '../types';

/**
 * BFF共通CORSミドルウェア
 *
 * BFF自身のドメインからのリクエストのみを許可する。
 * SELF_ORIGIN環境変数で明示的に許可オリジンを指定（動的導出を排除）。
 * user/admin 両 BFF で共有。
 */
export const bffCorsMiddleware = createMiddleware<{ Bindings: BffEnv }>(async (c, next) => {
  const appOrigin = c.env.SELF_ORIGIN;
  return cors({
    origin: appOrigin,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    credentials: true,
  })(c, next);
});

// CSRF検証が必要な安全でないHTTPメソッド
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * BFF共通CSRFミドルウェア
 *
 * 外部サービスからの直接アクセスを防ぐため、
 * OriginヘッダーがSELF_ORIGIN環境変数と一致することを検証する。
 * 動的導出ではなく明示的な環境変数を使用することで、
 * HTTP/HTTPSプロトコル混在によるバイパスリスクを排除。
 * user/admin 両 BFF で共有。
 *
 * GET/HEAD/OPTIONS はCSRF攻撃の対象外のためスキップする。
 * ブラウザは同一オリジンのGETリクエストにOriginヘッダーを付けないことがあるため、
 * 安全なメソッドに対してOriginを要求すると正規リクエストが誤拒否される。
 */
export const bffCsrfMiddleware = createMiddleware<{ Bindings: BffEnv }>(async (c, next) => {
  // 安全なメソッド（副作用なし）はCSRF検証をスキップ
  if (!UNSAFE_METHODS.has(c.req.method)) {
    return next();
  }

  const origin = c.req.header('Origin');

  if (!origin) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Origin header required' } }, 403);
  }

  const appOrigin = c.env.SELF_ORIGIN;

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
