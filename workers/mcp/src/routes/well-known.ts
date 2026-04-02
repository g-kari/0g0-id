import { Hono } from 'hono';

type Env = {
  Bindings: {
    IDP_ORIGIN: string;
    MCP_ORIGIN: string;
  };
};

const app = new Hono<Env>();

/**
 * Protected Resource Metadata (RFC 9728)
 * GET /.well-known/oauth-protected-resource
 *
 * OAuth クライアントがリソースサーバーの認可要件を自動検出するためのメタデータ。
 */
app.get('/oauth-protected-resource', (c): Response => {
  return c.json({
    resource: c.env.MCP_ORIGIN,
    authorization_servers: [c.env.IDP_ORIGIN],
    scopes_supported: ['openid', 'profile', 'email'],
    bearer_methods_supported: ['header'],
  });
});

export default app;
