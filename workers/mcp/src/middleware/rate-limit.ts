import { createMiddleware } from 'hono/factory';
import type { RateLimitBinding } from '@0g0-id/shared';
import { createLogger } from '@0g0-id/shared';

/**
 * バインディング未設定の警告を1 isolateにつき1回だけ出力するための追跡Set。
 * Cloudflare Workers の同一isolateはリクエスト間でモジュールレベル状態を共有するが、
 * isolate再起動（コールドスタート）時はリセットされる。
 */
const warnedBindings = new Set<string>();

const rateLimitLogger = createLogger('mcp-rate-limit');

type McpEnv = {
  Bindings: {
    DB: D1Database;
    IDP: Fetcher;
    IDP_ORIGIN: string;
    MCP_ORIGIN: string;
    RATE_LIMITER_MCP?: RateLimitBinding;
  };
};

/**
 * MCP エンドポイント向けレートリミッター（IP単位）。
 * 対象: /mcp/* 全エンドポイント
 *
 * 60リクエスト/分 を上限とする（wrangler.toml の rate_limit.limit に対応）。
 * RATE_LIMITER_MCP バインディングが未設定の場合はスキップ（ローカル開発・テスト時）。
 * cf-connecting-ip が未設定の場合は 'unknown' にフォールバックし警告ログを出力する。
 *
 * @retryAfterSeconds - RFC 6585 準拠の Retry-After ヘッダーに設定する待機秒数（60秒）。
 */
export const mcpRateLimitMiddleware = createMiddleware<McpEnv>(async (c, next): Promise<Response | void> => {
  const binding = c.env.RATE_LIMITER_MCP;
  if (!binding) {
    if (!warnedBindings.has('RATE_LIMITER_MCP')) {
      warnedBindings.add('RATE_LIMITER_MCP');
      rateLimitLogger.warn(
        '[rate-limit] RATE_LIMITER_MCP binding is not configured — rate limiting is DISABLED. Configure this binding in wrangler.toml for production deployments.',
      );
    }
    return next();
  }

  const ip = c.req.raw.headers.get('cf-connecting-ip') ?? 'unknown';
  if (ip === 'unknown') {
    rateLimitLogger.warn(
      '[rate-limit] RATE_LIMITER_MCP: rate limit key resolved to \'unknown\' — cf-connecting-ip may not be set. All requests share the same bucket.',
    );
  }

  const { success } = await binding.limit({ key: ip });
  if (!success) {
    return c.json(
      {
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many requests. Please try again later.',
        },
      },
      429,
      { 'Retry-After': '60' },
    );
  }

  await next();
});
