import type { BffEnv, RateLimitBinding } from "@0g0-id/shared";
import { createBffRateLimitMiddlewares } from "@0g0-id/shared";

type AdminRateLimitEnv = BffEnv & {
  RATE_LIMITER_ADMIN_AUTH?: RateLimitBinding;
  RATE_LIMITER_ADMIN_API?: RateLimitBinding;
};

const {
  authRateLimitMiddleware: adminAuthRateLimitMiddleware,
  apiRateLimitMiddleware: adminApiRateLimitMiddleware,
} = createBffRateLimitMiddlewares<AdminRateLimitEnv>({
  authBindingName: "RATE_LIMITER_ADMIN_AUTH",
  authGetBinding: (env) => env.RATE_LIMITER_ADMIN_AUTH,
  apiBindingName: "RATE_LIMITER_ADMIN_API",
  apiGetBinding: (env) => env.RATE_LIMITER_ADMIN_API,
});

export { adminAuthRateLimitMiddleware, adminApiRateLimitMiddleware };
