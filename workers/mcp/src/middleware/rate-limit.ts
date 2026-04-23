import type { RateLimitBinding } from "@0g0-id/shared";
import { createRateLimitMiddleware } from "@0g0-id/shared";

type McpEnv = {
  DB: D1Database;
  IDP: Fetcher;
  IDP_ORIGIN: string;
  MCP_ORIGIN: string;
  RATE_LIMITER_MCP?: RateLimitBinding;
};

export const mcpRateLimitMiddleware = createRateLimitMiddleware<McpEnv>({
  bindingName: "RATE_LIMITER_MCP",
  getBinding: (env) => env.RATE_LIMITER_MCP,
  getKey: (c) => c.req.raw.headers.get("cf-connecting-ip") ?? "unknown",
  errorMessage: "Too many requests. Please try again later.",
  isProduction: (env) => env.MCP_ORIGIN?.startsWith("https://") ?? false,
});
