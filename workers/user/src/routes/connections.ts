import { Hono } from "hono";
import { proxyGet, proxyMutate, restErrorBody, UUID_RE, COOKIE_NAMES } from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/connections
app.get(
  "/",
  proxyGet(COOKIE_NAMES.USER_SESSION, (c) => `${c.env.IDP_ORIGIN}/api/users/me/connections`),
);

// DELETE /api/connections/:serviceId
app.delete("/:serviceId", async (c) => {
  const serviceId = c.req.param("serviceId");
  if (!UUID_RE.test(serviceId)) {
    return c.json(restErrorBody("BAD_REQUEST", "Invalid service ID format"), 400);
  }
  return proxyMutate(
    c,
    COOKIE_NAMES.USER_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/me/connections/${serviceId}`,
  );
});

export default app;
