import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { RateLimitBinding } from "../types";
import { createLogger } from "../lib/logger";
import { restErrorBody } from "../lib/errors";

const warnedBindings = new Set<string>();

const rateLimitLogger = createLogger("rate-limit");

function logConfigWarning(
  isProduction: boolean,
  message: string,
  productionNote: string,
  developmentNote = "",
): void {
  const logFn = isProduction ? rateLimitLogger.error : rateLimitLogger.warn;
  logFn.call(rateLimitLogger, `${message}${isProduction ? productionNote : developmentNote}`);
}

export interface RateLimitOptions<
  E extends object = Record<string, unknown>,
  V extends Record<string, unknown> = Record<string, never>,
> {
  bindingName: string;
  getBinding: (env: E) => RateLimitBinding | undefined;
  getKey: (c: Context<{ Bindings: E; Variables: V }>) => string | Promise<string>;
  errorMessage: string;
  retryAfterSeconds?: number;
  isProduction?: (env: E) => boolean;
}

export function createRateLimitMiddleware<
  E extends object = Record<string, unknown>,
  V extends Record<string, unknown> = Record<string, never>,
>(options: RateLimitOptions<E, V>) {
  const {
    bindingName,
    getBinding,
    getKey,
    errorMessage,
    retryAfterSeconds = 60,
    isProduction,
  } = options;

  return createMiddleware<{ Bindings: E; Variables: V }>(async (c, next) => {
    const binding = getBinding(c.env);
    if (!binding) {
      const prod = isProduction?.(c.env) ?? false;
      if (!warnedBindings.has(bindingName)) {
        warnedBindings.add(bindingName);
        logConfigWarning(
          prod,
          `[rate-limit] ${bindingName} binding is not configured — rate limiting is DISABLED.`,
          " ⚠️ PRODUCTION: Configure this binding in wrangler.toml immediately.",
          " Configure this binding in wrangler.toml for production deployments.",
        );
      }
      if (prod) {
        return c.json(restErrorBody("SERVICE_UNAVAILABLE", "Rate limiter not configured"), 503);
      }
      return next();
    }
    const key = await getKey(c);
    if (key === "unknown") {
      const prod = isProduction?.(c.env) ?? false;
      logConfigWarning(
        prod,
        `[rate-limit] ${bindingName}: rate limit key resolved to 'unknown' — cf-connecting-ip may not be set. All requests share the same bucket.`,
        " ⚠️ PRODUCTION: Check Cloudflare proxy configuration.",
      );
    }
    const { success } = await binding.limit({ key });
    if (!success) {
      return c.json(restErrorBody("TOO_MANY_REQUESTS", errorMessage), 429, {
        "Retry-After": String(retryAfterSeconds),
      });
    }
    await next();
  });
}
