import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// @0g0-id/sharedの全関数をモック
vi.mock('@0g0-id/shared', () => ({
  findRefreshTokenByHash: vi.fn(),
  findServiceByClientId: vi.fn(),
  findUserById: vi.fn(),
  sha256: vi.fn(),
  timingSafeEqual: vi.fn(),
}));

import {
  findRefreshTokenByHash,
  findServiceByClientId,
  findUserById,
  sha256,
  timingSafeEqual,
} from '@0g0-id/shared';

import tokenRoutes from './token';

const baseUrl = 'https://id.0g0.xyz';

const mockEnv = {
  DB: {} as D1Database,
  IDP_ORIGIN: 'https://id.0g0.xyz',
};

const mockService = {
  id: 'service-1',
  name: 'Test Service',
  client_id: 'test-client-id',
  client_secret_hash: 'hashed-secret',
  allowed_scopes: JSON.stringify(['profile', 'email']),
  owner_user_id: 'admin-user-id',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const mockUser = {
  id: 'user-1',
  google_sub: 'google-sub-1',
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: 'test@example.com',
  email_verified: 1,
  name: 'Test User',
  picture: 'https://example.com/pic.jpg',
  phone: '090-0000-0000',
  address: 'Tokyo',
  role: 'user' as const,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const mockRefreshToken = {
  id: 'rt-id',
  user_id: 'user-1',
  service_id: 'service-1',
  token_hash: 'hashed-token',
  family_id: 'family-1',
  revoked_at: null,
  expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  created_at: '2024-01-01T00:00:00Z',
};

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route('/api/token', tokenRoutes);
  return app;
}

// Basic認証ヘッダーを生成
function makeBasicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function sendRequest(
  app: ReturnType<typeof buildApp>,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    authHeader?: string;
  } = {}
) {
  const { method = 'POST', body, authHeader } = options;
  const headers: Record<string, string> = {};
  if (authHeader) headers['Authorization'] = authHeader;
  if (body) headers['Content-Type'] = 'application/json';

  return app.request(
    new Request(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
    undefined,
    mockEnv as unknown as Record<string, string>
  );
}

// ===== POST /api/token/introspect =====
describe('POST /api/token/introspect', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue('hashed-token');
    vi.mocked(findServiceByClientId).mockResolvedValue(mockService as never);
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken as never);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
  });

  it('Authorizationヘッダーなし → { active: false } + 401', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'some-token' },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('Basicでないauth形式 → { active: false } + 401', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'some-token' },
      authHeader: 'Bearer some-token',
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('不正なBase64エンコード → { active: false } + 401', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'some-token' },
      authHeader: 'Basic !!!invalid!!!',
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('コロンなしのクレデンシャル → { active: false } + 401', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'some-token' },
      authHeader: `Basic ${btoa('nocredshere')}`,
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('存在しないサービス → { active: false } + 401', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'some-token' },
      authHeader: makeBasicAuth('unknown-client', 'secret'),
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('シークレット不一致 → { active: false } + 401', async () => {
    vi.mocked(timingSafeEqual).mockReturnValue(false);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'some-token' },
      authHeader: makeBasicAuth('test-client-id', 'wrong-secret'),
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('JSONボディが不正 → { active: false } + 400', async () => {
    const res = await buildApp().request(
      new Request(`${baseUrl}/api/token/introspect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: makeBasicAuth('test-client-id', 'secret'),
        },
        body: 'not-json',
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('tokenが未指定 → { active: false } + 400', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      body: {},
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('失効済みトークン → { active: false }', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: '2024-01-01T00:00:00Z',
    } as never);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'revoked-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('他サービスのトークン → { active: false }', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      service_id: 'other-service-id',
    } as never);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'other-service-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('期限切れトークン → { active: false }', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    } as never);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'expired-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('ユーザー不存在 → { active: false }', async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('有効なトークン → ユーザー情報を含む { active: true } を返す', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      active: boolean;
      sub: string;
      exp: number;
      scope: string;
      name: string;
      email: string;
    }>();
    expect(body.active).toBe(true);
    expect(body.sub).toBe('user-1');
    expect(body.scope).toBe('profile email');
    expect(body.name).toBe('Test User');
    expect(body.email).toBe('test@example.com');
  });

  it('profileスコープのみ → name/pictureを返すがemailは返さない', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue({
      ...mockService,
      allowed_scopes: JSON.stringify(['profile']),
    } as never);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.active).toBe(true);
    expect(body.name).toBe('Test User');
    expect(body.email).toBeUndefined();
  });

  it('emailスコープのみ → emailを返すがnameは返さない', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue({
      ...mockService,
      allowed_scopes: JSON.stringify(['email']),
    } as never);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.active).toBe(true);
    expect(body.email).toBe('test@example.com');
    expect(body.name).toBeUndefined();
  });

  it('トークンが存在しない → { active: false }', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'nonexistent-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('allowed_scopesのJSONが不正 → デフォルトスコープ（profile, email）を使用', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue({
      ...mockService,
      allowed_scopes: 'invalid-json',
    } as never);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.active).toBe(true);
    expect(body.scope).toBe('profile email');
  });
});
