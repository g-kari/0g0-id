import type { RateLimitBinding } from "@0g0-id/shared";
import { createRateLimitMiddleware } from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

type UserRateLimitEnv = BffEnv & {
  RATE_LIMITER_USER_AUTH?: RateLimitBinding;
  RATE_LIMITER_USER_API?: RateLimitBinding;
};

const isProduction = (env: UserRateLimitEnv): boolean =>
  env.SELF_ORIGIN?.startsWith("https://") ?? false;

export const userAuthRateLimitMiddleware = createRateLimitMiddleware<UserRateLimitEnv>({
  bindingName: "RATE_LIMITER_USER_AUTH",
  getBinding: (env) => env.RATE_LIMITER_USER_AUTH,
  getKey: (c) => c.req.raw.headers.get("cf-connecting-ip") ?? "unknown",
  errorMessage: "Too many requests. Please try again later.",
  isProduction,
});

export const userApiRateLimitMiddleware = createRateLimitMiddleware<UserRateLimitEnv>({
  bindingName: "RATE_LIMITER_USER_API",
  getBinding: (env) => env.RATE_LIMITER_USER_API,
  getKey: (c) => c.req.raw.headers.get("cf-connecting-ip") ?? "unknown",
  errorMessage: "Too many requests. Please try again later.",
  isProduction,
});
