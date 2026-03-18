import type { MiddlewareHandler } from 'hono';

export const logger = (): MiddlewareHandler => {
  return async (c, next) => {
    const start = Date.now();
    const { method, url } = c.req.raw;
    await next();
    const elapsed = Date.now() - start;
    console.log(`${method} ${url} ${c.res.status} ${elapsed}ms`);
  };
};
