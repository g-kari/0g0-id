import { Hono } from "hono";
import type { IdpEnv } from "@0g0-id/shared";
import {
  externalApiRateLimitMiddleware,
  tokenApiClientRateLimitMiddleware,
  tokenApiRateLimitMiddleware,
} from "../../middleware/rate-limit";
import { handleDeviceCodeGrant } from "../device";
import { handleAuthorizationCodeGrant } from "./authorization-code-grant";
import { handleRefreshTokenGrant } from "./refresh-token-grant";
import { handleIntrospect } from "./introspect";
import { handleRevoke } from "./revoke";

export type { TokenHandlerContext } from "./utils";

const app = new Hono<{ Bindings: IdpEnv }>();

// POST /api/token — 標準 OAuth 2.0 トークンエンドポイント (RFC 6749)
app.post("/", tokenApiRateLimitMiddleware, tokenApiClientRateLimitMiddleware, async (c) => {
  // RFC 6749 §4.1.3: application/x-www-form-urlencoded のみ受け付ける
  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "Content-Type must be application/x-www-form-urlencoded",
      },
      400,
    );
  }
  let params: Record<string, string>;
  try {
    const body = await c.req.parseBody();
    params = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") {
        params[key] = value;
      }
    }
  } catch {
    return c.json(
      { error: "invalid_request", error_description: "Failed to parse request body" },
      400,
    );
  }

  const grantType = params["grant_type"];

  if (grantType === "authorization_code") {
    return handleAuthorizationCodeGrant(c, params);
  } else if (grantType === "refresh_token") {
    return handleRefreshTokenGrant(c, params);
  } else if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
    return handleDeviceCodeGrant(c, params);
  } else {
    return c.json(
      { error: "unsupported_grant_type", error_description: "Unsupported grant_type" },
      400,
    );
  }
});

// POST /api/token/introspect — RFC 7662 トークンイントロスペクション
app.post("/introspect", externalApiRateLimitMiddleware, handleIntrospect);

// POST /api/token/revoke — RFC 7009 トークン失効
app.post("/revoke", externalApiRateLimitMiddleware, handleRevoke);

export default app;
