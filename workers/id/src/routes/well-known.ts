import { Hono } from "hono";
import {
  getJWTKeys,
  getJWKS,
  buildBaseOidcMetadata,
  buildOpenIdConfiguration,
} from "@0g0-id/shared";
import type { IdpEnv } from "@0g0-id/shared";

const app = new Hono<{ Bindings: IdpEnv }>();

app.get("/jwks.json", async (c) => {
  const { kid } = await getJWTKeys(c.env.JWT_PRIVATE_KEY, c.env.JWT_PUBLIC_KEY);
  const jwks = await getJWKS(c.env.JWT_PUBLIC_KEY, kid);
  return c.json(jwks, 200, {
    "Cache-Control": "public, max-age=3600",
  });
});

// GET /.well-known/openid-configuration — OIDC Discovery Document (RFC 8414 / OIDC Discovery 1.0)
app.get("/openid-configuration", (c) => {
  return c.json(buildOpenIdConfiguration(c.env.IDP_ORIGIN), 200, {
    "Cache-Control": "public, max-age=86400",
  });
});

// GET /.well-known/oauth-authorization-server — OAuth Authorization Server Metadata (RFC 8414)
app.get("/oauth-authorization-server", (c) => {
  return c.json(buildBaseOidcMetadata(c.env.IDP_ORIGIN), 200, {
    "Cache-Control": "public, max-age=86400",
  });
});

export default app;
