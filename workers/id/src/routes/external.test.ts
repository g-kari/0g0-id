import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// モジュールモック（sha256はAtob/Btoa依存のため直接モック）
vi.mock('@0g0-id/shared', async (importActual) => {
  const actual = await importActual<typeof import('@0g0-id/shared')>();
  return {
    ...actual,
    findUserById: vi.fn(),
    findUserIdByPairwiseSub: vi.fn(),
    findServiceByClientId: vi.fn(),
    sha256: vi.fn(),
    timingSafeEqual: vi.fn(),
    listUsersAuthorizedForService: vi.fn(),
    countUsersAuthorizedForService: vi.fn(),
  };
});

import {
  findUserById,
  findUserIdByPairwiseSub,
  findServiceByClientId,
  sha256,
  timingSafeEqual,
  listUsersAuthorizedForService,
  countUsersAuthorizedForService,
} from '@0g0-id/shared';

import externalRoutes from './external';

const mockFindUserById = vi.mocked(findUserById);
const mockFindUserIdByPairwiseSub = vi.mocked(findUserIdByPairwiseSub);
const mockFindServiceByClientId = vi.mocked(findServiceByClientId);
const mockSha256 = vi.mocked(sha256);
const mockTimingSafeEqual = vi.mocked(timingSafeEqual);
const mockListUsersAuthorizedForService = vi.mocked(listUsersAuthorizedForService);
const mockCountUsersAuthorizedForService = vi.mocked(countUsersAuthorizedForService);

// テスト用アプリケーション
function buildApp() {
  const app = new Hono<{ Bindings: { DB: D1Database } }>();
  app.route('/api/external', externalRoutes);
  return app;
}

const baseUrl = 'https://id.0g0.xyz';

// D1 DB モック（prepare().bind().all() チェーンをサポート）
function createMockDb(authorizedUserIds: string[] = []) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: authorizedUserIds.map((id) => ({ user_id: id })),
        }),
      }),
    }),
  } as unknown as D1Database;
}

const mockEnv = { DB: createMockDb() };

// Basic認証ヘッダーを生成
function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

// テストヘルパー: /api/external/users/:id へのリクエストを生成
function makeRequest(
  userId: string,
  auth?: string,
  headers?: Record<string, string>
): Request {
  return new Request(`${baseUrl}/api/external/users/${userId}`, {
    headers: { ...(auth ? { Authorization: auth } : {}), ...headers },
  });
}

// テストヘルパー: アプリにリクエストを送信
async function requestExternalUser(
  app: ReturnType<typeof buildApp>,
  userId: string,
  clientId = 'client-abc',
  clientSecret = 'secret'
) {
  return app.request(
    makeRequest(userId, basicAuth(clientId, clientSecret)),
    undefined,
    mockEnv as unknown as Record<string, string>
  );
}

// テストヘルパー: /api/external/users 一覧へのリクエストを送信
async function requestExternalUserList(
  app: ReturnType<typeof buildApp>,
  query?: Record<string, string>,
  clientId = 'client-abc',
  clientSecret = 'secret'
) {
  const params = query ? '?' + new URLSearchParams(query).toString() : '';
  return app.request(
    new Request(`${baseUrl}/api/external/users${params}`, {
      headers: { Authorization: basicAuth(clientId, clientSecret) },
    }),
    undefined,
    mockEnv as unknown as Record<string, string>
  );
}

const mockService = {
  id: 'service-1',
  name: 'Test Service',
  client_id: 'client-abc',
  client_secret_hash: 'hash-abc',
  allowed_scopes: JSON.stringify(['profile', 'email']),
  owner_user_id: 'owner-1',
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
  banned_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const PAIRWISE_SUB = 'pairwise-sub-hash';

describe('GET /api/external/users/:sub', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    // sha256はペアワイズsub（':'を含む）と認証用secretを区別する
    mockSha256.mockImplementation(async (input: string) =>
      input.includes(':') ? PAIRWISE_SUB : 'hash-abc'
    );
    mockTimingSafeEqual.mockReturnValue(true);
    mockFindServiceByClientId.mockResolvedValue(mockService);
    mockFindUserById.mockResolvedValue(mockUser);
    // ペアワイズsubによるユーザーID逆引き
    mockFindUserIdByPairwiseSub.mockResolvedValue('user-1');
  });

  describe('認証', () => {
    it('Authorizationヘッダーなし → 401を返す', async () => {
      const req = makeRequest('user-1');
      const res = await app.request(req, undefined, mockEnv as unknown as Record<string, string>);
      expect(res.status).toBe(401);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('不正なBase64 → 401を返す', async () => {
      mockFindServiceByClientId.mockResolvedValue(null);
      const req = makeRequest('user-1', 'Basic !!invalid!!');
      const res = await app.request(req, undefined, mockEnv as unknown as Record<string, string>);
      expect(res.status).toBe(401);
    });

    it('存在しないclient_id → 401を返す', async () => {
      mockFindServiceByClientId.mockResolvedValue(null);
      const res = await requestExternalUser(app, 'user-1', 'no-such-client', 'secret');
      expect(res.status).toBe(401);
    });

    it('client_secretが不一致 → 401を返す', async () => {
      mockTimingSafeEqual.mockReturnValue(false);
      const res = await requestExternalUser(app, 'user-1', 'client-abc', 'wrong-secret');
      expect(res.status).toBe(401);
    });
  });

  describe('エラーハンドリング', () => {
    it('DB障害時（findServiceByClientId） → 500を返す', async () => {
      mockFindServiceByClientId.mockRejectedValue(new Error('DB error'));
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      expect(res.status).toBe(500);
    });

    it('DB障害時（findUserIdByPairwiseSubエラー） → 500を返す', async () => {
      mockFindUserIdByPairwiseSub.mockRejectedValue(new Error('DB error'));
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      expect(res.status).toBe(500);
    });
  });

  describe('認可チェック（IDOR防止）', () => {
    it('ペアワイズsubに一致する認可済みユーザーがいない場合 → 404を返す', async () => {
      mockFindUserIdByPairwiseSub.mockResolvedValue(null);
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('認可済みの場合はユーザー情報を返す', async () => {
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      expect(res.status).toBe(200);
    });
  });

  describe('ユーザー検索', () => {
    it('存在するペアワイズsubで200とユーザー情報を返す', async () => {
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      expect(res.status).toBe(200);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.sub).toBe(PAIRWISE_SUB);
      expect(body.data.name).toBe('Test User');
      expect(body.data.email).toBe('test@example.com');
      expect(body.data.email_verified).toBe(true);
      expect(body.data.picture).toBe('https://example.com/pic.jpg');
    });

    it('ペアワイズsubが一致してもfindUserByIdがnull → 404を返す', async () => {
      mockFindUserById.mockResolvedValue(null);
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('スコープフィルタリング', () => {
    it('profile/emailスコープのみ → phone/addressを含まない', async () => {
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data).not.toHaveProperty('phone');
      expect(body.data).not.toHaveProperty('address');
    });

    it('全スコープ許可の場合 → phone/addressも返す', async () => {
      mockFindServiceByClientId.mockResolvedValue({
        ...mockService,
        allowed_scopes: JSON.stringify(['profile', 'email', 'phone', 'address']),
      });
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.phone).toBe('090-0000-0000');
      expect(body.data.address).toBe('Tokyo');
    });

    it('profileスコープなし → name/pictureを含まない', async () => {
      mockFindServiceByClientId.mockResolvedValue({
        ...mockService,
        allowed_scopes: JSON.stringify(['email']),
      });
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data).not.toHaveProperty('name');
      expect(body.data).not.toHaveProperty('picture');
      expect(body.data.email).toBe('test@example.com');
    });

    it('常にsubフィールドは返す', async () => {
      mockFindServiceByClientId.mockResolvedValue({
        ...mockService,
        allowed_scopes: JSON.stringify(['email']),
      });
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.sub).toBe(PAIRWISE_SUB);
    });

    it('allowed_scopesが不正なJSONの場合 → fail-closedでsubのみ返す', async () => {
      mockFindServiceByClientId.mockResolvedValue({
        ...mockService,
        allowed_scopes: 'invalid-json',
      });
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.sub).toBe(PAIRWISE_SUB);
      expect(body.data).not.toHaveProperty('name');
      expect(body.data).not.toHaveProperty('email');
    });
  });

  describe('セキュリティ: 内部情報の非公開', () => {
    it('内部IDを返さない（subのみ）', async () => {
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data).not.toHaveProperty('id');
      expect(body.data.sub).toBe(PAIRWISE_SUB);
    });

    it('google_sub等の内部IDを返さない', async () => {
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data).not.toHaveProperty('google_sub');
      expect(body.data).not.toHaveProperty('line_sub');
      expect(body.data).not.toHaveProperty('twitch_sub');
      expect(body.data).not.toHaveProperty('github_sub');
      expect(body.data).not.toHaveProperty('x_sub');
    });

    it('roleを返さない', async () => {
      const res = await requestExternalUser(app, PAIRWISE_SUB);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data).not.toHaveProperty('role');
    });
  });
});

describe('GET /api/external/users', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    // sha256はペアワイズsub（':'を含む）と認証用secretを区別する
    mockSha256.mockImplementation(async (input: string) =>
      input.includes(':') ? PAIRWISE_SUB : 'hash-abc'
    );
    mockTimingSafeEqual.mockReturnValue(true);
    mockFindServiceByClientId.mockResolvedValue(mockService);
    mockListUsersAuthorizedForService.mockResolvedValue([mockUser]);
    mockCountUsersAuthorizedForService.mockResolvedValue(1);
    mockEnv.DB = createMockDb();
  });

  describe('認証', () => {
    it('Authorizationヘッダーなし → 401を返す', async () => {
      const res = await app.request(
        new Request(`${baseUrl}/api/external/users`),
        undefined,
        mockEnv as unknown as Record<string, string>
      );
      expect(res.status).toBe(401);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('client_secretが不一致 → 401を返す', async () => {
      mockTimingSafeEqual.mockReturnValue(false);
      const res = await requestExternalUserList(app, {}, 'client-abc', 'wrong');
      expect(res.status).toBe(401);
    });
  });

  describe('一覧取得', () => {
    it('認可済みユーザー一覧を返す', async () => {
      const res = await requestExternalUserList(app);
      expect(res.status).toBe(200);
      const body = await res.json<{
        data: Record<string, unknown>[];
        meta: { total: number; limit: number; offset: number };
      }>();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].sub).toBe(PAIRWISE_SUB);
      expect(body.data[0].name).toBe('Test User');
      expect(body.data[0].email).toBe('test@example.com');
    });

    it('metaフィールドにtotal/limit/offsetを含む', async () => {
      const res = await requestExternalUserList(app);
      const body = await res.json<{
        meta: { total: number; limit: number; offset: number };
      }>();
      expect(body.meta.total).toBe(1);
      expect(body.meta.limit).toBe(50);
      expect(body.meta.offset).toBe(0);
    });

    it('ユーザーが0件の場合は空配列を返す', async () => {
      mockListUsersAuthorizedForService.mockResolvedValue([]);
      mockCountUsersAuthorizedForService.mockResolvedValue(0);
      const res = await requestExternalUserList(app);
      const body = await res.json<{
        data: unknown[];
        meta: { total: number };
      }>();
      expect(body.data).toHaveLength(0);
      expect(body.meta.total).toBe(0);
    });
  });

  describe('ページネーション', () => {
    it('limitとoffsetクエリパラメータを受け付ける', async () => {
      const res = await requestExternalUserList(app, { limit: '10', offset: '5' });
      expect(res.status).toBe(200);
      expect(mockListUsersAuthorizedForService).toHaveBeenCalledWith(
        expect.anything(),
        'service-1',
        10,
        5,
        {}
      );
    });

    it('limitが範囲外（>100）の場合はmaxLimitの100に丸める', async () => {
      const res = await requestExternalUserList(app, { limit: '200' });
      expect(res.status).toBe(200);
      expect(mockListUsersAuthorizedForService).toHaveBeenCalledWith(
        expect.anything(),
        'service-1',
        100,
        0,
        {}
      );
    });

    it('limitが不正な文字列の場合は400を返す', async () => {
      const res = await requestExternalUserList(app, { limit: 'abc' });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('limitが整数でない場合（小数点）は400を返す', async () => {
      const res = await requestExternalUserList(app, { limit: '1.5' });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('offsetが負の場合は400を返す', async () => {
      const res = await requestExternalUserList(app, { offset: '-5' });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('セキュリティ: 内部情報の非公開', () => {
    it('一覧レスポンスにも内部IDを含まない', async () => {
      const res = await requestExternalUserList(app);
      const body = await res.json<{ data: Record<string, unknown>[] }>();
      expect(body.data[0]).not.toHaveProperty('id');
      expect(body.data[0]).not.toHaveProperty('google_sub');
      expect(body.data[0]).not.toHaveProperty('github_sub');
      expect(body.data[0]).not.toHaveProperty('x_sub');
      expect(body.data[0]).not.toHaveProperty('role');
    });

    it('一覧レスポンスにはsubフィールドが含まれる', async () => {
      const res = await requestExternalUserList(app);
      const body = await res.json<{ data: Record<string, unknown>[] }>();
      expect(body.data[0].sub).toBe(PAIRWISE_SUB);
    });
  });

  describe('エラーハンドリング', () => {
    it('DB障害時 → 500を返す', async () => {
      mockListUsersAuthorizedForService.mockRejectedValue(new Error('DB error'));
      const res = await requestExternalUserList(app);
      expect(res.status).toBe(500);
    });
  });

  describe('検索フィルタリング', () => {
    it('nameクエリでlistUsersAuthorizedForServiceにfilterを渡す', async () => {
      const res = await requestExternalUserList(app, { name: 'Test' });
      expect(res.status).toBe(200);
      expect(mockListUsersAuthorizedForService).toHaveBeenCalledWith(
        expect.anything(),
        'service-1',
        50,
        0,
        expect.objectContaining({ name: 'Test' })
      );
      expect(mockCountUsersAuthorizedForService).toHaveBeenCalledWith(
        expect.anything(),
        'service-1',
        expect.objectContaining({ name: 'Test' })
      );
    });

    it('emailクエリでlistUsersAuthorizedForServiceにfilterを渡す', async () => {
      const res = await requestExternalUserList(app, { email: 'test@example.com' });
      expect(res.status).toBe(200);
      expect(mockListUsersAuthorizedForService).toHaveBeenCalledWith(
        expect.anything(),
        'service-1',
        50,
        0,
        expect.objectContaining({ email: 'test@example.com' })
      );
      expect(mockCountUsersAuthorizedForService).toHaveBeenCalledWith(
        expect.anything(),
        'service-1',
        expect.objectContaining({ email: 'test@example.com' })
      );
    });

    it('nameとemailを同時に指定できる', async () => {
      const res = await requestExternalUserList(app, { name: 'Test', email: 'test@example.com' });
      expect(res.status).toBe(200);
      expect(mockListUsersAuthorizedForService).toHaveBeenCalledWith(
        expect.anything(),
        'service-1',
        50,
        0,
        expect.objectContaining({ name: 'Test', email: 'test@example.com' })
      );
    });

    it('profileスコープなしでnameフィルターを使用すると403', async () => {
      mockFindServiceByClientId.mockResolvedValue({
        ...mockService,
        allowed_scopes: JSON.stringify(['email']),
      });
      const res = await requestExternalUserList(app, { name: 'Test' });
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('emailスコープなしでemailフィルターを使用すると403', async () => {
      mockFindServiceByClientId.mockResolvedValue({
        ...mockService,
        allowed_scopes: JSON.stringify(['profile']),
      });
      const res = await requestExternalUserList(app, { email: 'test@example.com' });
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('フィルターなしの場合は従来どおり動作する', async () => {
      const res = await requestExternalUserList(app);
      expect(res.status).toBe(200);
      expect(mockListUsersAuthorizedForService).toHaveBeenCalledWith(
        expect.anything(),
        'service-1',
        50,
        0,
        {}
      );
      expect(mockCountUsersAuthorizedForService).toHaveBeenCalledWith(
        expect.anything(),
        'service-1',
        {}
      );
    });
  });
});
