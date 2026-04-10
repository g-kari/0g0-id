import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import wellKnownRoutes from './well-known';

const baseUrl = 'https://mcp.0g0.xyz';

const mockEnv = {
  IDP_ORIGIN: 'https://id.0g0.xyz',
  MCP_ORIGIN: 'https://mcp.0g0.xyz',
};

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route('/.well-known', wellKnownRoutes);
  return app;
}

describe('GET /.well-known/oauth-protected-resource', () => {
  it('200を返しProtected Resource Metadataを返す', async () => {
    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/oauth-protected-resource`),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.resource).toBe('https://mcp.0g0.xyz');
  });

  it('authorization_serversにIdP OriginのURLが含まれる', async () => {
    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/oauth-protected-resource`),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    const body = await res.json<{ authorization_servers: string[] }>();
    expect(body.authorization_servers).toContain('https://id.0g0.xyz');
  });

  it('scopes_supportedにopenid/profile/emailを含む', async () => {
    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/oauth-protected-resource`),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    const body = await res.json<{ scopes_supported: string[] }>();
    expect(body.scopes_supported).toContain('openid');
    expect(body.scopes_supported).toContain('profile');
    expect(body.scopes_supported).toContain('email');
  });

  it('bearer_methods_supportedにheaderを含む（RFC 6750）', async () => {
    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/oauth-protected-resource`),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    const body = await res.json<{ bearer_methods_supported: string[] }>();
    expect(body.bearer_methods_supported).toContain('header');
  });

  it('環境変数MCP_ORIGINがresourceに反映される', async () => {
    const app = buildApp();
    const customEnv = {
      IDP_ORIGIN: 'https://id.example.com',
      MCP_ORIGIN: 'https://mcp.example.com',
    };
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/oauth-protected-resource`),
      undefined,
      customEnv as unknown as Record<string, string>
    );
    const body = await res.json<{ resource: string; authorization_servers: string[] }>();
    expect(body.resource).toBe('https://mcp.example.com');
    expect(body.authorization_servers).toContain('https://id.example.com');
  });
});
