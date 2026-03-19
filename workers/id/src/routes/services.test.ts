import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// @0g0-id/sharedの全関数をモック
vi.mock('@0g0-id/shared', () => ({
  listServices: vi.fn(),
  findServiceById: vi.fn(),
  createService: vi.fn(),
  updateServiceAllowedScopes: vi.fn(),
  deleteService: vi.fn(),
  listRedirectUris: vi.fn(),
  addRedirectUri: vi.fn(),
  deleteRedirectUri: vi.fn(),
  generateClientId: vi.fn(),
  generateClientSecret: vi.fn(),
  sha256: vi.fn(),
  normalizeRedirectUri: vi.fn(),
  verifyAccessToken: vi.fn(),
}));

import {
  listServices,
  findServiceById,
  createService,
  updateServiceAllowedScopes,
  deleteService,
  listRedirectUris,
  addRedirectUri,
  deleteRedirectUri,
  generateClientId,
  generateClientSecret,
  sha256,
  normalizeRedirectUri,
  verifyAccessToken,
} from '@0g0-id/shared';

import servicesRoutes from './services';

const baseUrl = 'https://id.0g0.xyz';

const mockEnv = {
  DB: {} as D1Database,
  JWT_PUBLIC_KEY: 'mock-public-key',
  IDP_ORIGIN: 'https://id.0g0.xyz',
  USER_ORIGIN: 'https://user.0g0.xyz',
  ADMIN_ORIGIN: 'https://admin.0g0.xyz',
};

// 管理者トークンペイロード
const mockAdminPayload = {
  iss: 'https://id.0g0.xyz',
  sub: 'admin-user-id',
  aud: 'https://id.0g0.xyz',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  jti: 'jti-admin',
  kid: 'key-1',
  email: 'admin@example.com',
  role: 'admin' as const,
};

// 一般ユーザートークンペイロード
const mockUserPayload = {
  ...mockAdminPayload,
  sub: 'regular-user-id',
  email: 'user@example.com',
  role: 'user' as const,
};

const mockService = {
  id: 'service-1',
  name: 'Test Service',
  client_id: 'client-abc',
  client_secret_hash: 'hash-abc',
  allowed_scopes: JSON.stringify(['profile', 'email']),
  owner_user_id: 'admin-user-id',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const mockRedirectUri = {
  id: 'uri-1',
  service_id: 'service-1',
  uri: 'https://app.example.com/callback',
  created_at: '2024-01-01T00:00:00Z',
};

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route('/api/services', servicesRoutes);
  return app;
}

// リクエストヘルパー
function makeRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    origin?: string;
    withAuth?: boolean;
  } = {}
) {
  const { method = 'GET', body, origin, withAuth = true } = options;
  const headers: Record<string, string> = {};
  if (withAuth) headers['Authorization'] = 'Bearer mock-token';
  if (origin) headers['Origin'] = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  return new Request(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function sendRequest(
  app: ReturnType<typeof buildApp>,
  path: string,
  options: Parameters<typeof makeRequest>[1] = {}
) {
  return app.request(
    makeRequest(path, options),
    undefined,
    mockEnv as unknown as Record<string, string>
  );
}

// ===== GET /api/services（管理者のみ）=====
describe('GET /api/services', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(listServices).mockResolvedValue([mockService]);
  });

  it('認証なし → 401を返す', async () => {
    const res = await sendRequest(app, '/api/services', { withAuth: false });
    expect(res.status).toBe(401);
  });

  it('管理者でない場合 → 403を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, '/api/services');
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('サービス一覧を返す', async () => {
    const res = await sendRequest(app, '/api/services');
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(1);
  });

  it('client_secret_hashを含まない', async () => {
    const res = await sendRequest(app, '/api/services');
    const body = await res.json<{ data: Record<string, unknown>[] }>();
    expect(body.data[0]).not.toHaveProperty('client_secret_hash');
  });

  it('サービスが0件の場合は空配列を返す', async () => {
    vi.mocked(listServices).mockResolvedValue([]);
    const res = await sendRequest(app, '/api/services');
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(0);
  });
});

// ===== POST /api/services（管理者のみ）=====
describe('POST /api/services', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(generateClientId).mockReturnValue('generated-client-id');
    vi.mocked(generateClientSecret).mockReturnValue('generated-client-secret');
    vi.mocked(sha256).mockResolvedValue('hashed-secret');
    vi.mocked(createService).mockResolvedValue({
      ...mockService,
      client_id: 'generated-client-id',
    });
  });

  it('管理者でない場合 → 403を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, '/api/services', {
      method: 'POST',
      body: { name: 'New Service' },
    });
    expect(res.status).toBe(403);
  });

  it('サービスを作成して201とclient_secretを返す', async () => {
    const res = await sendRequest(app, '/api/services', {
      method: 'POST',
      body: { name: 'New Service' },
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.client_id).toBe('generated-client-id');
    expect(body.data.client_secret).toBe('generated-client-secret');
  });

  it('client_secretは作成時のみレスポンスに含まれる', async () => {
    const res = await sendRequest(app, '/api/services', {
      method: 'POST',
      body: { name: 'New Service' },
    });
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data).toHaveProperty('client_secret');
    // client_secret_hashは返さない
    expect(body.data).not.toHaveProperty('client_secret_hash');
  });

  it('nameがない場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services', {
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('nameが空文字の場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services', {
      method: 'POST',
      body: { name: '' },
    });
    expect(res.status).toBe(400);
  });

  it('不正なJSONボディ → 400を返す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/services`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer mock-token',
          'Content-Type': 'application/json',
        },
        body: 'invalid-json',
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
  });

  it('allowed_scopesを指定できる', async () => {
    const res = await sendRequest(app, '/api/services', {
      method: 'POST',
      body: { name: 'New Service', allowed_scopes: ['profile', 'email', 'phone'] },
    });
    expect(res.status).toBe(201);
    expect(vi.mocked(createService)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        allowedScopes: JSON.stringify(['profile', 'email', 'phone']),
      })
    );
  });

  it('allowed_scopesを省略した場合はデフォルト値を使用', async () => {
    const res = await sendRequest(app, '/api/services', {
      method: 'POST',
      body: { name: 'New Service' },
    });
    expect(res.status).toBe(201);
    expect(vi.mocked(createService)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        allowedScopes: JSON.stringify(['profile', 'email']),
      })
    );
  });
});

// ===== PATCH /api/services/:id（管理者のみ）=====
describe('PATCH /api/services/:id', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(updateServiceAllowedScopes).mockResolvedValue({
      ...mockService,
      allowed_scopes: JSON.stringify(['profile', 'email', 'phone']),
    });
  });

  it('管理者でない場合 → 403を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, '/api/services/service-1', {
      method: 'PATCH',
      body: { allowed_scopes: ['profile'] },
    });
    expect(res.status).toBe(403);
  });

  it('allowed_scopesを更新して返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1', {
      method: 'PATCH',
      body: { allowed_scopes: ['profile', 'email', 'phone'] },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.allowed_scopes).toBe(JSON.stringify(['profile', 'email', 'phone']));
  });

  it('allowed_scopesが配列でない場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1', {
      method: 'PATCH',
      body: { allowed_scopes: 'profile' },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('不正なスコープが含まれる場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1', {
      method: 'PATCH',
      body: { allowed_scopes: ['profile', 'invalid_scope'] },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('invalid_scope');
  });

  it('空配列の場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1', {
      method: 'PATCH',
      body: { allowed_scopes: [] },
    });
    expect(res.status).toBe(400);
  });

  it('サービスが存在しない場合 → 404を返す', async () => {
    vi.mocked(updateServiceAllowedScopes).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/no-such-service', {
      method: 'PATCH',
      body: { allowed_scopes: ['profile'] },
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ===== DELETE /api/services/:id（管理者のみ）=====
describe('DELETE /api/services/:id', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(deleteService).mockResolvedValue();
  });

  it('管理者でない場合 → 403を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, '/api/services/service-1', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('サービスを削除して204を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(vi.mocked(deleteService)).toHaveBeenCalledWith(expect.anything(), 'service-1');
  });

  it('サービスが存在しない場合 → 404を返す', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/no-such', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ===== GET /api/services/:id/redirect-uris（管理者のみ）=====
describe('GET /api/services/:id/redirect-uris', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(listRedirectUris).mockResolvedValue([mockRedirectUri]);
  });

  it('管理者でない場合 → 403を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, '/api/services/service-1/redirect-uris');
    expect(res.status).toBe(403);
  });

  it('リダイレクトURI一覧を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/redirect-uris');
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ uri: 'https://app.example.com/callback' });
  });

  it('サービスが存在しない場合 → 404を返す', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/no-such/redirect-uris');
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ===== POST /api/services/:id/redirect-uris（管理者のみ）=====
describe('POST /api/services/:id/redirect-uris', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(normalizeRedirectUri).mockReturnValue('https://app.example.com/callback');
    vi.mocked(addRedirectUri).mockResolvedValue(mockRedirectUri);
  });

  it('管理者でない場合 → 403を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, '/api/services/service-1/redirect-uris', {
      method: 'POST',
      body: { uri: 'https://app.example.com/callback' },
    });
    expect(res.status).toBe(403);
  });

  it('リダイレクトURIを追加して201を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/redirect-uris', {
      method: 'POST',
      body: { uri: 'https://app.example.com/callback' },
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.uri).toBe('https://app.example.com/callback');
  });

  it('サービスが存在しない場合 → 404を返す', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/no-such/redirect-uris', {
      method: 'POST',
      body: { uri: 'https://app.example.com/callback' },
    });
    expect(res.status).toBe(404);
  });

  it('uriがない場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/redirect-uris', {
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('不正なURIの場合 → 400を返す', async () => {
    vi.mocked(normalizeRedirectUri).mockReturnValue(null);
    const res = await sendRequest(app, '/api/services/service-1/redirect-uris', {
      method: 'POST',
      body: { uri: 'not-a-valid-uri' },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('重複するURIの場合 → 409を返す', async () => {
    vi.mocked(addRedirectUri).mockRejectedValue(new Error('UNIQUE constraint failed'));
    const res = await sendRequest(app, '/api/services/service-1/redirect-uris', {
      method: 'POST',
      body: { uri: 'https://app.example.com/callback' },
    });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('CONFLICT');
  });
});

// ===== DELETE /api/services/:id/redirect-uris/:uriId（管理者のみ）=====
describe('DELETE /api/services/:id/redirect-uris/:uriId', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(deleteRedirectUri).mockResolvedValue();
  });

  it('管理者でない場合 → 403を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, '/api/services/service-1/redirect-uris/uri-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });

  it('リダイレクトURIを削除して204を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/redirect-uris/uri-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(vi.mocked(deleteRedirectUri)).toHaveBeenCalledWith(
      expect.anything(),
      'uri-1',
      'service-1'
    );
  });

  it('サービスが存在しない場合 → 404を返す', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/no-such/redirect-uris/uri-1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
