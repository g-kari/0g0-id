import { Hono } from "hono";
import { proxyGet, proxyMutate, isValidProvider, COOKIE_NAMES } from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/providers — 連携済みSNSプロバイダー一覧
app.get(
  "/",
  proxyGet(COOKIE_NAMES.USER_SESSION, (c) => `${c.env.IDP_ORIGIN}/api/users/me/providers`),
);

// DELETE /api/providers/:provider — SNSプロバイダー連携解除
app.delete("/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isValidProvider(provider)) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Invalid provider" } }, 400);
  }
  return proxyMutate(
    c,
    COOKIE_NAMES.USER_SESSION,
    `${c.env.IDP_ORIGIN}/api/users/me/providers/${provider}`,
  );
});

export default app;
