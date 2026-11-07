import { Hono } from "hono";
import { COOKIE_NAMES, generateToken, setOAuthStateCookie } from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

type Env = BffEnv & { PASSKEY_LOGIN_ENABLED?: string };
const app = new Hono<{ Bindings: Env }>();

// Separate from OAuthProvider and the SNS-link routes. Both worker flags must
// be enabled operationally; the IdP gate is authoritative and fails closed.
app.get("/passkey/status", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ enabled: c.env.PASSKEY_LOGIN_ENABLED === "true" });
});
app.get("/passkey", (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  if (c.env.PASSKEY_LOGIN_ENABLED !== "true") return c.notFound();
  const state = generateToken(16);
  setOAuthStateCookie(c, COOKIE_NAMES.USER_STATE, state);
  const target = new URL("/auth/passkey/start", c.env.IDP_ORIGIN);
  target.searchParams.set("redirect_to", new URL("/auth/callback", c.env.SELF_ORIGIN).toString());
  target.searchParams.set("state", state);
  return c.redirect(target.toString());
});

export default app;
