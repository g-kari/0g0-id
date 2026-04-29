import type { IdpEnv, TokenPayload } from "@0g0-id/shared";
import { createRateLimitMiddleware } from "@0g0-id/shared";
import { extractClientIdFromBody } from "../utils/body-parser";
import { getClientIp } from "../utils/ip";
import { parseBasicAuth } from "../utils/service-auth";

const isProduction = (env: IdpEnv): boolean => env.IDP_ORIGIN?.startsWith("https://") ?? false;

/** Basic認証ヘッダーから client_id を抽出する。取得できない場合は null を返す */
function extractClientId(authHeader: string | undefined): string | null {
  return parseBasicAuth(authHeader)?.clientId ?? null;
}

export const authRateLimitMiddleware = createRateLimitMiddleware<IdpEnv, { user?: TokenPayload }>({
  bindingName: "RATE_LIMITER_AUTH",
  getBinding: (env) => env.RATE_LIMITER_AUTH,
  getKey: (c) => getClientIp(c.req.raw) ?? "unknown",
  errorMessage: "Too many requests. Please try again later.",
  isProduction,
});

export const externalApiRateLimitMiddleware = createRateLimitMiddleware<
  IdpEnv,
  { user?: TokenPayload }
>({
  bindingName: "RATE_LIMITER_EXTERNAL",
  getBinding: (env) => env.RATE_LIMITER_EXTERNAL,
  getKey: (c) =>
    extractClientId(c.req.header("Authorization")) ?? getClientIp(c.req.raw) ?? "unknown",
  errorMessage: "Rate limit exceeded.",
  isProduction,
});

export const tokenApiRateLimitMiddleware = createRateLimitMiddleware<
  IdpEnv,
  { user?: TokenPayload }
>({
  bindingName: "RATE_LIMITER_TOKEN",
  getBinding: (env) => env.RATE_LIMITER_TOKEN,
  getKey: (c) => getClientIp(c.req.raw) ?? "unknown",
  errorMessage: "Too many requests. Please try again later.",
  isProduction,
});

export const tokenApiClientRateLimitMiddleware = createRateLimitMiddleware<
  IdpEnv,
  { user?: TokenPayload }
>({
  bindingName: "RATE_LIMITER_TOKEN_CLIENT",
  getBinding: (env) => env.RATE_LIMITER_TOKEN_CLIENT,
  getKey: async (c) => {
    const headerClientId = extractClientId(c.req.header("Authorization"));
    if (headerClientId) return headerClientId;
    const bodyClientId = await extractClientIdFromBody(c.req);
    return bodyClientId ?? getClientIp(c.req.raw) ?? "unknown";
  },
  errorMessage: "Too many requests for this client. Please try again later.",
  isProduction,
});

export const deviceVerifyRateLimitMiddleware = createRateLimitMiddleware<
  IdpEnv,
  { user?: TokenPayload }
>({
  bindingName: "RATE_LIMITER_DEVICE_VERIFY",
  getBinding: (env) => env.RATE_LIMITER_DEVICE_VERIFY,
  getKey: (c) => {
    const user = c.get("user");
    return user?.sub ?? getClientIp(c.req.raw) ?? "unknown";
  },
  errorMessage: "Too many verification attempts. Please try again later.",
  isProduction,
});
