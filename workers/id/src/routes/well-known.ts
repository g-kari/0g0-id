import { Hono } from 'hono';
import { getJWTKeys, getJWKS } from '@0g0-id/shared';
import type { IdpEnv } from '@0g0-id/shared';

const app = new Hono<{ Bindings: IdpEnv }>();

app.get('/jwks.json', async (c) => {
  const { kid } = await getJWTKeys(c.env.JWT_PRIVATE_KEY, c.env.JWT_PUBLIC_KEY);
  const jwks = await getJWKS(c.env.JWT_PUBLIC_KEY, kid);
  return c.json(jwks, 200, {
    'Cache-Control': 'public, max-age=3600',
  });
});

// GET /.well-known/openid-configuration — OIDC Discovery Document (RFC 8414 / OIDC Discovery 1.0)
app.get('/openid-configuration', (c) => {
  const issuer = c.env.IDP_ORIGIN;
  return c.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/auth/authorize`,
      token_endpoint: `${issuer}/api/token`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      userinfo_endpoint: `${issuer}/api/userinfo`,
      introspection_endpoint: `${issuer}/api/token/introspect`,
      revocation_endpoint: `${issuer}/api/token/revoke`,
      device_authorization_endpoint: `${issuer}/api/device/code`,
      scopes_supported: ['openid', 'profile', 'email', 'phone', 'address'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
      subject_types_supported: ['pairwise'],
      id_token_signing_alg_values_supported: ['ES256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
      code_challenge_methods_supported: ['S256'],
    },
    200,
    { 'Cache-Control': 'public, max-age=86400' }
  );
});

// GET /.well-known/oauth-authorization-server — OAuth Authorization Server Metadata (RFC 8414)
app.get('/oauth-authorization-server', (c) => {
  const issuer = c.env.IDP_ORIGIN;
  return c.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/auth/authorize`,
      token_endpoint: `${issuer}/api/token`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      scopes_supported: ['openid', 'profile', 'email', 'phone', 'address'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
      code_challenge_methods_supported: ['S256'],
      device_authorization_endpoint: `${issuer}/api/device/code`,
      revocation_endpoint: `${issuer}/api/token/revoke`,
      introspection_endpoint: `${issuer}/api/token/introspect`,
    },
    200,
    { 'Cache-Control': 'public, max-age=86400' }
  );
});

export default app;
