import { Hono } from "hono";
import {
  fetchWithAuth,
  isValidProvider,
  paginationMiddleware,
  proxyResponse,
  restErrorBody,
  COOKIE_NAMES,
} from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/login-history
app.get("/", paginationMiddleware({ defaultLimit: 20, maxLimit: 100 }), async (c) => {
  const { limit, offset } = c.get("pagination");
  const url = new URL(`${c.env.IDP_ORIGIN}/api/users/me/login-history`);
  if (c.req.query("limit") !== undefined) url.searchParams.set("limit", String(limit));
  if (c.req.query("offset") !== undefined) url.searchParams.set("offset", String(offset));
  const provider = c.req.query("provider");
  if (provider) {
    if (!isValidProvider(provider)) {
      return c.json(restErrorBody("BAD_REQUEST", "Invalid provider"), 400);
    }
    url.searchParams.set("provider", provider);
  }
  const res = await fetchWithAuth(c, COOKIE_NAMES.USER_SESSION, url.toString());
  return proxyResponse(res);
});

export default app;
