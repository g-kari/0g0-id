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
