import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { IdpEnv, RateLimitBinding } from '@0g0-id/shared';

/**
 * バインディング未設定の警告を1ワーカーインスタンスにつき1回だけ出力するための追跡Set。
 * wrangler.toml の設定漏れを本番デプロイ直後のログで即座に検知できる。
 */
const warnedBindings = new Set<string>();

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

type IdpContext = Context<{ Bindings: IdpEnv }>;

/**
 * レートリミットミドルウェアのファクトリ関数。
 * バインディングの取得・キー抽出・エラーメッセージを差し込むことで
 * 各エンドポイント向けのミドルウェアを生成する。
 *
 * バインディングが未設定の場合は最初のリクエスト時に1度だけ警告ログを出力し、
 * レートリミットをスキップする（ローカル開発・テスト時を想定）。
 * 本番環境でバインディング名を typo したままデプロイした場合でも
 * ログで即座に検知できる。
 */
function createRateLimitMiddleware(
  bindingName: string,
  getBinding: (env: IdpEnv) => RateLimitBinding | undefined,
  getKey: (c: IdpContext) => string,
  errorMessage: string,
) {
  return createMiddleware<{ Bindings: IdpEnv }>(async (c, next) => {
    const binding = getBinding(c.env);
    if (!binding) {
      if (!warnedBindings.has(bindingName)) {
        warnedBindings.add(bindingName);
        console.warn(
          `[rate-limit] ${bindingName} binding is not configured — rate limiting is DISABLED. ` +
            'Configure this binding in wrangler.toml for production deployments.'
        );
      }
      return next();
    }
    const key = getKey(c);
    const { success } = await binding.limit({ key });
    if (!success) {
      return c.json(
        {
          error: {
            code: 'TOO_MANY_REQUESTS',
            message: errorMessage,
          },
        },
        429
      );
    }
    await next();
  });
}

/**
 * 認証フロー向けレートリミッター（IP単位）。
 * 対象: GET /auth/login, GET /auth/callback
 *
 * RATE_LIMITER_AUTH バインディングが未設定の場合はスキップ（ローカル開発・テスト時）。
 */
export const authRateLimitMiddleware = createRateLimitMiddleware(
  'RATE_LIMITER_AUTH',
  (env) => env.RATE_LIMITER_AUTH,
  (c) => getClientIp(c.req.raw),
  'Too many requests. Please try again later.',
);

/**
 * 外部サービス向けレートリミッター（client_id 単位）。
 * 対象: GET /api/external/*, POST /api/token/introspect
 *
 * client_id が取得できない場合は IP をキーとして使用する。
 * RATE_LIMITER_EXTERNAL バインディングが未設定の場合はスキップ。
 */
export const externalApiRateLimitMiddleware = createRateLimitMiddleware(
  'RATE_LIMITER_EXTERNAL',
  (env) => env.RATE_LIMITER_EXTERNAL,
  (c) => extractClientId(c.req.header('Authorization')) ?? getClientIp(c.req.raw),
  'Rate limit exceeded.',
);

/**
 * トークンエンドポイント向けレートリミッター（IP単位）。
 * 対象: POST /auth/exchange, POST /auth/refresh
 *
 * コード横取り・リフレッシュトークンブルートフォースを緩和する。
 * RATE_LIMITER_TOKEN バインディングが未設定の場合はスキップ（ローカル開発・テスト時）。
 */
export const tokenApiRateLimitMiddleware = createRateLimitMiddleware(
  'RATE_LIMITER_TOKEN',
  (env) => env.RATE_LIMITER_TOKEN,
  (c) => getClientIp(c.req.raw),
  'Too many requests. Please try again later.',
);
