import type { MiddlewareHandler } from 'hono';
import { createLogger } from '../lib/logger';

const SENSITIVE_PARAMS_RE =
  /([?&])(code|state|token|access_token|refresh_token|code_verifier|client_secret)=([^&#]*)/g;

function maskSensitiveParams(urlStr: string): string {
  // URLパースのオーバーヘッドを回避: スキーム後のパス部分を正規表現で抽出・マスク
  const schemeEnd = urlStr.indexOf('://');
  const pathStart = schemeEnd === -1 ? 0 : urlStr.indexOf('/', schemeEnd + 3);
  const pathAndQuery = pathStart <= 0 ? urlStr : urlStr.slice(pathStart);
  if (!pathAndQuery.includes('?')) return pathAndQuery;
  return pathAndQuery.replace(SENSITIVE_PARAMS_RE, '$1$2=[REDACTED]');
}

const httpLogger = createLogger('http');

export const logger = (): MiddlewareHandler => {
  return async (c, next) => {
    const start = Date.now();
    const { method, url } = c.req.raw;
    await next();
    const elapsed = Date.now() - start;
    httpLogger.info('request', {
      method,
      path: maskSensitiveParams(url),
      status: c.res.status,
      elapsed_ms: elapsed,
    });
  };
};
