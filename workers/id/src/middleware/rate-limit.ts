import { createMiddleware } from 'hono/factory';
import type { IdpEnv } from '@0g0-id/shared';

/** リクエスト元IPアドレスを取得する（Cloudflare → x-forwarded-for の順にフォールバック） */
function getClientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

/** Basic認証ヘッダーから client_id を抽出する。取得できない場合は null を返す */
function extractClientId(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Basic ')) return null;
  try {
    const credentials = atob(authHeader.slice(6));
    const colonIndex = credentials.indexOf(':');
    return colonIndex !== -1 ? credentials.slice(0, colonIndex) : null;
  } catch {
    return null;
  }
}

/**
 * 認証フロー向けレートリミッター（IP単位）。
 * 対象: GET /auth/login, GET /auth/callback
 *
 * RATE_LIMITER_AUTH バインディングが未設定の場合はスキップ（ローカル開発・テスト時）。
 */
export const authRateLimitMiddleware = createMiddleware<{ Bindings: IdpEnv }>(
  async (c, next) => {
    if (c.env.RATE_LIMITER_AUTH) {
      const key = getClientIp(c.req.raw);
      const { success } = await c.env.RATE_LIMITER_AUTH.limit({ key });
      if (!success) {
        return c.json(
          {
            error: {
              code: 'TOO_MANY_REQUESTS',
              message: 'Too many requests. Please try again later.',
            },
          },
          429
        );
      }
    }
    await next();
  }
);

/**
 * 外部サービス向けレートリミッター（client_id 単位）。
 * 対象: GET /api/external/*, POST /api/token/introspect
 *
 * client_id が取得できない場合は IP をキーとして使用する。
 * RATE_LIMITER_EXTERNAL バインディングが未設定の場合はスキップ。
 */
export const externalApiRateLimitMiddleware = createMiddleware<{ Bindings: IdpEnv }>(
  async (c, next) => {
    if (c.env.RATE_LIMITER_EXTERNAL) {
      const clientId = extractClientId(c.req.header('Authorization'));
      const key = clientId ?? getClientIp(c.req.raw);
      const { success } = await c.env.RATE_LIMITER_EXTERNAL.limit({ key });
      if (!success) {
        return c.json(
          {
            error: {
              code: 'TOO_MANY_REQUESTS',
              message: 'Rate limit exceeded.',
            },
          },
          429
        );
      }
    }
    await next();
  }
);
