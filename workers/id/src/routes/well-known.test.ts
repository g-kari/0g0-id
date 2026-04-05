import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@0g0-id/shared', () => ({
  getJWTKeys: vi.fn(),
  getJWKS: vi.fn(),
}));

import { getJWTKeys, getJWKS } from '@0g0-id/shared';
import wellKnownRoutes from './well-known';

const baseUrl = 'https://id.0g0.xyz';

const mockEnv = {
  JWT_PRIVATE_KEY: 'mock-private-key',
  JWT_PUBLIC_KEY: 'mock-public-key',
};

const mockJwks = {
  keys: [
    {
      kty: 'EC',
      crv: 'P-256',
      x: 'mock-x',
      y: 'mock-y',
      kid: 'mock-kid-1234',
      use: 'sig',
      alg: 'ES256',
    },
  ],
};

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route('/.well-known', wellKnownRoutes);
  return app;
}

describe('GET /.well-known/jwks.json', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getJWTKeys).mockResolvedValue({
      kid: 'mock-kid-1234',
      privateKey: {} as CryptoKey,
      publicKey: {} as CryptoKey,
    });
    vi.mocked(getJWKS).mockResolvedValue(mockJwks);
  });

  it('200を返してJWKSを返す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/jwks.json`),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(200);
    const body = await res.json<typeof mockJwks>();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].alg).toBe('ES256');
    expect(body.keys[0].kid).toBe('mock-kid-1234');
  });

  it('Cache-Controlヘッダーが設定されている', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/jwks.json`),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('getJWTKeysに正しいキーを渡す', async () => {
    await app.request(
      new Request(`${baseUrl}/.well-known/jwks.json`),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(vi.mocked(getJWTKeys)).toHaveBeenCalledWith(
      mockEnv.JWT_PRIVATE_KEY,
      mockEnv.JWT_PUBLIC_KEY
    );
    expect(vi.mocked(getJWKS)).toHaveBeenCalledWith(mockEnv.JWT_PUBLIC_KEY, 'mock-kid-1234');
  });
});

describe('GET /.well-known/openid-configuration', () => {
  const mockEnvWithOrigin = {
    ...mockEnv,
    IDP_ORIGIN: 'https://id.0g0.xyz',
  };

  function buildAppWithOrigin() {
    const app = new Hono<{ Bindings: typeof mockEnvWithOrigin }>();
    app.route('/.well-known', wellKnownRoutes);
    return app;
  }

  it('200を返してDiscovery Documentを返す', async () => {
    const app = buildAppWithOrigin();
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/openid-configuration`),
      undefined,
      mockEnvWithOrigin as unknown as Record<string, string>
    );
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.issuer).toBe('https://id.0g0.xyz');
    expect(body.authorization_endpoint).toBe('https://id.0g0.xyz/auth/authorize');
    expect(body.token_endpoint).toBe('https://id.0g0.xyz/api/token');
    expect(body.jwks_uri).toBe('https://id.0g0.xyz/.well-known/jwks.json');
    expect(body.userinfo_endpoint).toBe('https://id.0g0.xyz/api/userinfo');
    expect(body.introspection_endpoint).toBe('https://id.0g0.xyz/api/token/introspect');
    expect(body.revocation_endpoint).toBe('https://id.0g0.xyz/api/token/revoke');
  });

  it('必須スコープを含む', async () => {
    const app = buildAppWithOrigin();
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/openid-configuration`),
      undefined,
      mockEnvWithOrigin as unknown as Record<string, string>
    );
    const body = await res.json<{ scopes_supported: string[] }>();
    expect(body.scopes_supported).toContain('openid');
    expect(body.scopes_supported).toContain('profile');
    expect(body.scopes_supported).toContain('email');
    expect(body.scopes_supported).toContain('phone');
    expect(body.scopes_supported).toContain('address');
  });

  it('response_types_supported に code を含む', async () => {
    const app = buildAppWithOrigin();
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/openid-configuration`),
      undefined,
      mockEnvWithOrigin as unknown as Record<string, string>
    );
    const body = await res.json<{ response_types_supported: string[] }>();
    expect(body.response_types_supported).toContain('code');
  });

  it('id_token_signing_alg_values_supported に ES256 を含む', async () => {
    const app = buildAppWithOrigin();
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/openid-configuration`),
      undefined,
      mockEnvWithOrigin as unknown as Record<string, string>
    );
    const body = await res.json<{ id_token_signing_alg_values_supported: string[] }>();
    expect(body.id_token_signing_alg_values_supported).toContain('ES256');
  });

  it('code_challenge_methods_supported に S256 を含む（PKCE対応）', async () => {
    const app = buildAppWithOrigin();
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/openid-configuration`),
      undefined,
      mockEnvWithOrigin as unknown as Record<string, string>
    );
    const body = await res.json<{ code_challenge_methods_supported: string[] }>();
    expect(body.code_challenge_methods_supported).toContain('S256');
  });

  it('Cache-Controlヘッダーが1日に設定されている', async () => {
    const app = buildAppWithOrigin();
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/openid-configuration`),
      undefined,
      mockEnvWithOrigin as unknown as Record<string, string>
    );
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });

  it('subject_types_supported に pairwise を含む', async () => {
    const app = buildAppWithOrigin();
    const res = await app.request(
      new Request(`${baseUrl}/.well-known/openid-configuration`),
      undefined,
      mockEnvWithOrigin as unknown as Record<string, string>
    );
    const body = await res.json<{ subject_types_supported: string[] }>();
    expect(body.subject_types_supported).toContain('pairwise');
  });
});

