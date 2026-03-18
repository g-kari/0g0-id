import type { MiddlewareHandler } from 'hono';

const SENSITIVE_PARAMS = new Set([
  'code',
  'state',
  'token',
  'access_token',
  'refresh_token',
  'code_verifier',
  'client_secret',
]);

function maskSensitiveParams(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    for (const key of u.searchParams.keys()) {
      if (SENSITIVE_PARAMS.has(key)) {
        u.searchParams.set(key, '[REDACTED]');
      }
    }
    return `${u.pathname}${u.search}`;
  } catch {
    return urlStr;
  }
}

export const logger = (): MiddlewareHandler => {
  return async (c, next) => {
    const start = Date.now();
    const { method, url } = c.req.raw;
    await next();
    const elapsed = Date.now() - start;
    console.log(`${method} ${maskSensitiveParams(url)} ${c.res.status} ${elapsed}ms`);
  };
};
