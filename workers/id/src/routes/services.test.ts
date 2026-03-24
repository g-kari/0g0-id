import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// @0g0-id/sharedの全関数をモック
vi.mock('@0g0-id/shared', () => ({
  listServices: vi.fn(),
  findServiceById: vi.fn(),
  findUserById: vi.fn(),
  createService: vi.fn(),
  updateServiceFields: vi.fn(),
  
  deleteService: vi.fn(),
  listRedirectUris: vi.fn(),
  addRedirectUri: vi.fn(),
  deleteRedirectUri: vi.fn(),
  generateClientId: vi.fn(),
  generateClientSecret: vi.fn(),
  sha256: vi.fn(),
  normalizeRedirectUri: vi.fn(),
  rotateClientSecret: vi.fn(),
  transferServiceOwnership: vi.fn(),
  listUsersAuthorizedForService: vi.fn(),
  countUsersAuthorizedForService: vi.fn(),
  revokeUserServiceTokens: vi.fn(),
  parsePagination: (
    query: { limit?: string; offset?: string },
    options: { defaultLimit: number; maxLimit: number } = { defaultLimit: 20, maxLimit: 100 }
  ) => {
    const limitRaw = query.limit !== undefined ? parseInt(query.limit, 10) : options.defaultLimit;
    const offsetRaw = query.offset !== undefined ? parseInt(query.offset, 10) : 0;
    if (query.limit !== undefined && (isNaN(limitRaw) || limitRaw < 1)) {
      return { error: 'limit は1以上の整数で指定してください' };
    }
    if (query.offset !== undefined && (isNaN(offsetRaw) || offsetRaw < 0)) {
      return { error: 'offset は0以上の整数で指定してください' };
    }
    return { limit: Math.min(limitRaw, options.maxLimit), offset: offsetRaw };
  },
  verifyAccessToken: vi.fn(),
}));

import {
  listServices,
  findServiceById,
  findUserById,
  createService,
  updateServiceFields,
  deleteService,
  listRedirectUris,
  addRedirectUri,
  deleteRedirectUri,
  generateClientId,
  generateClientSecret,
  sha256,
  normalizeRedirectUri,
  rotateClientSecret,
  transferServiceOwnership,
  listUsersAuthorizedForService,
  countUsersAuthorizedForService,
  revokeUserServiceTokens,
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

// ===== GET /api/services/:id（管理者のみ）=====
describe('GET /api/services/:id', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
  });

  it('認証なし → 401を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1', { withAuth: false });
    expect(res.status).toBe(401);
  });

  it('管理者でない場合 → 403を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, '/api/services/service-1');
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('サービスを取得して返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1');
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.id).toBe('service-1');
    expect(body.data.name).toBe('Test Service');
    expect(body.data.client_id).toBe('client-abc');
    expect(vi.mocked(findServiceById)).toHaveBeenCalledWith(expect.anything(), 'service-1');
  });

  it('client_secret_hashを含まない', async () => {
    const res = await sendRequest(app, '/api/services/service-1');
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data).not.toHaveProperty('client_secret_hash');
  });

  it('サービスが存在しない場合 → 404を返す', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/nonexistent');
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
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

  it('Originヘッダーなし → 403を返す', async () => {
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
      origin: 'https://admin.0g0.xyz',
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
      origin: 'https://admin.0g0.xyz',
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
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('nameが空文字の場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services', {
      method: 'POST',
      body: { name: '' },
      origin: 'https://admin.0g0.xyz',
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
          Origin: 'https://admin.0g0.xyz',
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
      origin: 'https://admin.0g0.xyz',
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
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(201);
    expect(vi.mocked(createService)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        allowedScopes: JSON.stringify(['profile', 'email']),
      })
    );
  });

  it('不正なスコープが含まれる場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services', {
      method: 'POST',
      body: { name: 'New Service', allowed_scopes: ['profile', 'invalid_scope'] },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('profile');
  });

  it('空のallowed_scopesを指定した場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services', {
      method: 'POST',
      body: { name: 'New Service', allowed_scopes: [] },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('allowed_scopes must not be empty');
  });

  it('nameが101文字 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services', {
      method: 'POST',
      body: { name: 'a'.repeat(101) },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });
});

// ===== PATCH /api/services/:id（管理者のみ）=====
describe('PATCH /api/services/:id', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(updateServiceFields).mockResolvedValue({
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
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.allowed_scopes).toBe(JSON.stringify(['profile', 'email', 'phone']));
  });

  it('allowed_scopesが配列でない場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1', {
      method: 'PATCH',
      body: { allowed_scopes: 'profile' },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('不正なスコープが含まれる場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1', {
      method: 'PATCH',
      body: { allowed_scopes: ['profile', 'invalid_scope'] },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('profile');
  });

  it('空配列の場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1', {
      method: 'PATCH',
      body: { allowed_scopes: [] },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(400);
  });

  it('サービスが存在しない場合 → 404を返す', async () => {
    vi.mocked(updateServiceFields).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/no-such-service', {
      method: 'PATCH',
      body: { allowed_scopes: ['profile'] },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('nameのみ更新する', async () => {
    vi.mocked(updateServiceFields).mockResolvedValue({
      ...mockService,
      name: '新しいサービス名',
    });
    const res = await sendRequest(app, '/api/services/service-1', {
      method: 'PATCH',
      body: { name: '新しいサービス名' },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.name).toBe('新しいサービス名');
    expect(vi.mocked(updateServiceFields)).toHaveBeenCalledWith(
      expect.anything(),
      'service-1',
      { name: '新しいサービス名' }
    );
  });

  it('nameとallowed_scopesを同時に更新する', async () => {
    vi.mocked(updateServiceFields).mockResolvedValue({
      ...mockService,
      name: '新しいサービス名',
      allowed_scopes: JSON.stringify(['profile']),
    });
    const res = await sendRequest(app, '/api/services/service-1', {
      method: 'PATCH',
      body: { name: '新しいサービス名', allowed_scopes: ['profile'] },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(updateServiceFields)).toHaveBeenCalledWith(
      expect.anything(),
      'service-1',
      { name: '新しいサービス名', allowedScopes: JSON.stringify(['profile']) }
    );
  });

  it('nameもallowed_scopesも省略した場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1', {
      method: 'PATCH',
      body: {},
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('nameが空文字の場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1', {
      method: 'PATCH',
      body: { name: '' },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('nameが存在しないサービスの場合 → 404を返す', async () => {
    vi.mocked(updateServiceFields).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/no-such', {
      method: 'PATCH',
      body: { name: '新しい名前' },
      origin: 'https://admin.0g0.xyz',
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
    const res = await sendRequest(app, '/api/services/service-1', {
      method: 'DELETE',
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(204);
    expect(vi.mocked(deleteService)).toHaveBeenCalledWith(expect.anything(), 'service-1');
  });

  it('サービスが存在しない場合 → 404を返す', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/no-such', {
      method: 'DELETE',
      origin: 'https://admin.0g0.xyz',
    });
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
      origin: 'https://admin.0g0.xyz',
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
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(404);
  });

  it('uriがない場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/redirect-uris', {
      method: 'POST',
      body: {},
      origin: 'https://admin.0g0.xyz',
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
      origin: 'https://admin.0g0.xyz',
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
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('CONFLICT');
  });
});

// ===== POST /api/services/:id/rotate-secret（管理者のみ）=====
describe('POST /api/services/:id/rotate-secret', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(generateClientSecret).mockReturnValue('new-client-secret');
    vi.mocked(sha256).mockResolvedValue('new-secret-hash');
    vi.mocked(rotateClientSecret).mockResolvedValue({
      ...mockService,
      client_secret_hash: 'new-secret-hash',
      updated_at: '2024-06-01T00:00:00Z',
    });
  });

  it('認証なし → 401を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/rotate-secret', {
      method: 'POST',
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });

  it('管理者でない場合 → 403を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, '/api/services/service-1/rotate-secret', {
      method: 'POST',
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(403);
  });

  it('Originヘッダーなし（CSRF）→ 403を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/rotate-secret', {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });

  it('新しいclient_secretを発行して返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/rotate-secret', {
      method: 'POST',
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.id).toBe('service-1');
    expect(body.data.client_id).toBe('client-abc');
    expect(body.data.client_secret).toBe('new-client-secret');
    expect(body.data).not.toHaveProperty('client_secret_hash');
  });

  it('rotateClientSecretが新しいハッシュで呼ばれる', async () => {
    await sendRequest(app, '/api/services/service-1/rotate-secret', {
      method: 'POST',
      origin: 'https://admin.0g0.xyz',
    });
    expect(vi.mocked(rotateClientSecret)).toHaveBeenCalledWith(
      expect.anything(),
      'service-1',
      'new-secret-hash'
    );
  });

  it('サービスが存在しない場合（findServiceById）→ 404を返す', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/no-such/rotate-secret', {
      method: 'POST',
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ===== PATCH /api/services/:id/owner（管理者のみ）=====
describe('PATCH /api/services/:id/owner', () => {
  const app = buildApp();

  const mockNewOwner = {
    id: 'new-owner-id',
    email: 'newowner@example.com',
    name: 'New Owner',
    picture: null,
    phone: null,
    address: null,
    role: 'user' as const,
    google_sub: null,
    line_sub: null,
    twitch_sub: null,
    github_sub: null,
    x_sub: null,
    email_verified: 1,
    banned_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(findUserById).mockResolvedValue(mockNewOwner);
    vi.mocked(transferServiceOwnership).mockResolvedValue({
      ...mockService,
      owner_user_id: 'new-owner-id',
      updated_at: '2024-06-01T00:00:00Z',
    });
  });

  it('認証なし → 401を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/owner', {
      method: 'PATCH',
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });

  it('管理者でない場合 → 403を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, '/api/services/service-1/owner', {
      method: 'PATCH',
      body: { new_owner_user_id: 'new-owner-id' },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(403);
  });

  it('Originヘッダーなし（CSRF）→ 403を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/owner', {
      method: 'PATCH',
      body: { new_owner_user_id: 'new-owner-id' },
    });
    expect(res.status).toBe(403);
  });

  it('所有権を転送して新しいowner_user_idを返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/owner', {
      method: 'PATCH',
      body: { new_owner_user_id: 'new-owner-id' },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.id).toBe('service-1');
    expect(body.data.owner_user_id).toBe('new-owner-id');
    expect(vi.mocked(transferServiceOwnership)).toHaveBeenCalledWith(
      expect.anything(),
      'service-1',
      'new-owner-id'
    );
  });

  it('client_secret_hashを含まない', async () => {
    const res = await sendRequest(app, '/api/services/service-1/owner', {
      method: 'PATCH',
      body: { new_owner_user_id: 'new-owner-id' },
      origin: 'https://admin.0g0.xyz',
    });
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data).not.toHaveProperty('client_secret_hash');
  });

  it('サービスが存在しない場合 → 404を返す', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/no-such/owner', {
      method: 'PATCH',
      body: { new_owner_user_id: 'new-owner-id' },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('新しいオーナーが存在しない場合 → 404を返す', async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/service-1/owner', {
      method: 'PATCH',
      body: { new_owner_user_id: 'nonexistent-user' },
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('owner');
  });

  it('new_owner_user_idが省略された場合 → 400を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/owner', {
      method: 'PATCH',
      body: {},
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('不正なJSONボディ → 400を返す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/services/service-1/owner`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer mock-token',
          'Content-Type': 'application/json',
          Origin: 'https://admin.0g0.xyz',
        },
        body: 'invalid-json',
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
  });
});

// ===== GET /api/services/:id/users（管理者のみ）=====
describe('GET /api/services/:id/users', () => {
  const app = buildApp();

  const mockAuthorizedUser = {
    id: 'user-1',
    email: 'user@example.com',
    name: 'Test User',
    picture: null,
    phone: null,
    address: null,
    role: 'user' as const,
    google_sub: null,
    line_sub: null,
    twitch_sub: null,
    github_sub: null,
    x_sub: null,
    email_verified: 1,
    banned_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(listUsersAuthorizedForService).mockResolvedValue([mockAuthorizedUser]);
    vi.mocked(countUsersAuthorizedForService).mockResolvedValue(1);
  });

  it('認証なし → 401を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/users', { withAuth: false });
    expect(res.status).toBe(401);
  });

  it('管理者でない場合 → 403を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, '/api/services/service-1/users');
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('サービスが存在しない場合 → 404を返す', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/no-such/users');
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('認可済みユーザー一覧とtotalを返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/users');
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown>[]; total: number }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('user-1');
    expect(body.data[0].email).toBe('user@example.com');
    expect(body.total).toBe(1);
  });

  it('センシティブなフィールドを含まない', async () => {
    const res = await sendRequest(app, '/api/services/service-1/users');
    const body = await res.json<{ data: Record<string, unknown>[] }>();
    expect(body.data[0]).not.toHaveProperty('google_sub');
    expect(body.data[0]).not.toHaveProperty('phone');
    expect(body.data[0]).not.toHaveProperty('address');
  });

  it('認可済みユーザーが0件の場合は空配列を返す', async () => {
    vi.mocked(listUsersAuthorizedForService).mockResolvedValue([]);
    vi.mocked(countUsersAuthorizedForService).mockResolvedValue(0);
    const res = await sendRequest(app, '/api/services/service-1/users');
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; total: number }>();
    expect(body.data).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('limitとoffsetをDBに渡す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/services/service-1/users?limit=10&offset=20`, {
        headers: { Authorization: 'Bearer mock-token' },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listUsersAuthorizedForService)).toHaveBeenCalledWith(
      expect.anything(),
      'service-1',
      10,
      20
    );
  });

  it('limitの上限は100', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/services/service-1/users?limit=999`, {
        headers: { Authorization: 'Bearer mock-token' },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listUsersAuthorizedForService)).toHaveBeenCalledWith(
      expect.anything(),
      'service-1',
      100,
      0
    );
  });
});

// ===== DELETE /api/services/:id/users/:userId（管理者のみ）=====
describe('DELETE /api/services/:id/users/:userId', () => {
  const app = buildApp();

  const mockTargetUser = {
    id: 'target-user-id',
    email: 'target@example.com',
    name: 'Target User',
    picture: null,
    phone: null,
    address: null,
    role: 'user' as const,
    google_sub: null,
    line_sub: null,
    twitch_sub: null,
    github_sub: null,
    x_sub: null,
    email_verified: 1,
    banned_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(findUserById).mockResolvedValue(mockTargetUser);
    vi.mocked(revokeUserServiceTokens).mockResolvedValue(2);
  });

  it('認証なし → 401を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/users/target-user-id', {
      method: 'DELETE',
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });

  it('管理者でない場合 → 403を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, '/api/services/service-1/users/target-user-id', {
      method: 'DELETE',
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('Originヘッダーなし（CSRF）→ 403を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/users/target-user-id', {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });

  it('認可を失効させて204を返す', async () => {
    const res = await sendRequest(app, '/api/services/service-1/users/target-user-id', {
      method: 'DELETE',
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(204);
    expect(vi.mocked(revokeUserServiceTokens)).toHaveBeenCalledWith(
      expect.anything(),
      'target-user-id',
      'service-1'
    );
  });

  it('サービスが存在しない場合 → 404を返す', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/no-such/users/target-user-id', {
      method: 'DELETE',
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('ユーザーが存在しない場合 → 404を返す', async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/services/service-1/users/no-such-user', {
      method: 'DELETE',
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('アクティブな認可がない場合 → 404を返す', async () => {
    vi.mocked(revokeUserServiceTokens).mockResolvedValue(0);
    const res = await sendRequest(app, '/api/services/service-1/users/target-user-id', {
      method: 'DELETE',
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
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
      origin: 'https://admin.0g0.xyz',
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
      origin: 'https://admin.0g0.xyz',
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
