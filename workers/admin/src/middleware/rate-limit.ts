import type { RateLimitBinding } from "@0g0-id/shared";
import { createRateLimitMiddleware } from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

type AdminRateLimitEnv = BffEnv & {
  RATE_LIMITER_ADMIN_AUTH?: RateLimitBinding;
  RATE_LIMITER_ADMIN_API?: RateLimitBinding;
};

const isProduction = (env: AdminRateLimitEnv): boolean =>
  env.SELF_ORIGIN?.startsWith("https://") ?? false;

export const adminAuthRateLimitMiddleware = createRateLimitMiddleware<AdminRateLimitEnv>({
  bindingName: "RATE_LIMITER_ADMIN_AUTH",
  getBinding: (env) => env.RATE_LIMITER_ADMIN_AUTH,
  getKey: (c) => c.req.raw.headers.get("cf-connecting-ip") ?? "unknown",
  errorMessage: "Too many requests. Please try again later.",
  isProduction,
});

export const adminApiRateLimitMiddleware = createRateLimitMiddleware<AdminRateLimitEnv>({
  bindingName: "RATE_LIMITER_ADMIN_API",
  getBinding: (env) => env.RATE_LIMITER_ADMIN_API,
  getKey: (c) => c.req.raw.headers.get("cf-connecting-ip") ?? "unknown",
  errorMessage: "Too many requests. Please try again later.",
  isProduction,
});
