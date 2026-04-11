import { Hono } from "hono";
import { fetchWithAuth, proxyMutate, proxyResponse, UUID_RE } from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";
import { SESSION_COOKIE } from "./auth";

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/connections
app.get("/", async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/connections`,
  );
  return proxyResponse(res);
});

// DELETE /api/connections/:serviceId
app.delete("/:serviceId", async (c) => {
  const serviceId = c.req.param("serviceId");
  if (!UUID_RE.test(serviceId)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid service ID format" } }, 400);
  }
  return proxyMutate(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/connections/${serviceId}`,
  );
});

export default app;
