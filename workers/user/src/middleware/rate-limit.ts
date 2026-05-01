import type { BffEnv, RateLimitBinding } from "@0g0-id/shared";
import { createBffRateLimitMiddlewares } from "@0g0-id/shared";

type UserRateLimitEnv = BffEnv & {
  RATE_LIMITER_USER_AUTH?: RateLimitBinding;
  RATE_LIMITER_USER_API?: RateLimitBinding;
};

const {
  authRateLimitMiddleware: userAuthRateLimitMiddleware,
  apiRateLimitMiddleware: userApiRateLimitMiddleware,
} = createBffRateLimitMiddlewares<UserRateLimitEnv>({
  authBindingName: "RATE_LIMITER_USER_AUTH",
  authGetBinding: (env) => env.RATE_LIMITER_USER_AUTH,
  apiBindingName: "RATE_LIMITER_USER_API",
  apiGetBinding: (env) => env.RATE_LIMITER_USER_API,
});

export { userAuthRateLimitMiddleware, userApiRateLimitMiddleware };
