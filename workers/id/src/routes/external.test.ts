import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// モジュールモック（sha256はAtob/Btoa依存のため直接モック）
vi.mock('@0g0-id/shared', () => ({
  findUserById: vi.fn(),
  findServiceByClientId: vi.fn(),
  sha256: vi.fn(),
  timingSafeEqual: vi.fn(),
  hasUserAuthorizedService: vi.fn(),
}));

import {
  findUserById,
  findServiceByClientId,
  sha256,
  timingSafeEqual,
  hasUserAuthorizedService,
} from '@0g0-id/shared';

import externalRoutes from './external';

const mockFindUserById = vi.mocked(findUserById);
const mockFindServiceByClientId = vi.mocked(findServiceByClientId);
const mockSha256 = vi.mocked(sha256);
const mockTimingSafeEqual = vi.mocked(timingSafeEqual);
const mockHasUserAuthorizedService = vi.mocked(hasUserAuthorizedService);

// テスト用アプリケーション
function buildApp() {
  const app = new Hono<{ Bindings: { DB: D1Database } }>();
  app.route('/api/external', externalRoutes);
  return app;
}

const baseUrl = 'https://id.0g0.xyz';
// Cloudflare Workers Bindingsのモック（DBはsharedモックが肩代わりするためnullで可）
const mockEnv = { DB: {} as D1Database };

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

// Basic認証ヘッダーを生成
function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

describe('GET /api/external/users/:id', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSha256.mockResolvedValue('hash-abc');
    mockTimingSafeEqual.mockReturnValue(true);
    mockFindServiceByClientId.mockResolvedValue(mockService);
    mockHasUserAuthorizedService.mockResolvedValue(true);
    mockFindUserById.mockResolvedValue(mockUser);
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
      const res = await requestExternalUser(app, 'user-1');
      expect(res.status).toBe(500);
    });

    it('DB障害時（hasUserAuthorizedService） → 500を返す', async () => {
      mockHasUserAuthorizedService.mockRejectedValue(new Error('DB error'));
      const res = await requestExternalUser(app, 'user-1');
      expect(res.status).toBe(500);
    });
  });

  describe('認可チェック（IDOR防止）', () => {
    it('ユーザーがサービスを認可していない場合 → 404を返す', async () => {
      mockHasUserAuthorizedService.mockResolvedValue(false);
      const res = await requestExternalUser(app, 'user-1');
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('認可済みの場合はユーザー情報を返す', async () => {
      mockHasUserAuthorizedService.mockResolvedValue(true);
      const res = await requestExternalUser(app, 'user-1');
      expect(res.status).toBe(200);
    });
  });

  describe('ユーザー検索', () => {
    it('存在するユーザーIDで200とユーザー情報を返す', async () => {
      const res = await requestExternalUser(app, 'user-1');
      expect(res.status).toBe(200);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.id).toBe('user-1');
      expect(body.data.name).toBe('Test User');
      expect(body.data.email).toBe('test@example.com');
      expect(body.data.email_verified).toBe(true);
      expect(body.data.picture).toBe('https://example.com/pic.jpg');
    });

    it('存在しないユーザーID → 404を返す', async () => {
      mockFindUserById.mockResolvedValue(null);
      const res = await requestExternalUser(app, 'no-such-user');
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('スコープフィルタリング', () => {
    it('profile/emailスコープのみ → phone/addressを含まない', async () => {
      const res = await requestExternalUser(app, 'user-1');
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data).not.toHaveProperty('phone');
      expect(body.data).not.toHaveProperty('address');
    });

    it('全スコープ許可の場合 → phone/addressも返す', async () => {
      mockFindServiceByClientId.mockResolvedValue({
        ...mockService,
        allowed_scopes: JSON.stringify(['profile', 'email', 'phone', 'address']),
      });
      const res = await requestExternalUser(app, 'user-1');
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.phone).toBe('090-0000-0000');
      expect(body.data.address).toBe('Tokyo');
    });

    it('profileスコープなし → name/pictureを含まない', async () => {
      mockFindServiceByClientId.mockResolvedValue({
        ...mockService,
        allowed_scopes: JSON.stringify(['email']),
      });
      const res = await requestExternalUser(app, 'user-1');
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data).not.toHaveProperty('name');
      expect(body.data).not.toHaveProperty('picture');
      expect(body.data.email).toBe('test@example.com');
    });

    it('常にidフィールドは返す', async () => {
      mockFindServiceByClientId.mockResolvedValue({
        ...mockService,
        allowed_scopes: JSON.stringify(['email']),
      });
      const res = await requestExternalUser(app, 'user-1');
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.id).toBe('user-1');
    });

    it('allowed_scopesが不正なJSONの場合 → fail-closedでidのみ返す', async () => {
      mockFindServiceByClientId.mockResolvedValue({
        ...mockService,
        allowed_scopes: 'invalid-json',
      });
      const res = await requestExternalUser(app, 'user-1');
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.id).toBe('user-1');
      expect(body.data).not.toHaveProperty('name');
      expect(body.data).not.toHaveProperty('email');
    });
  });

  describe('セキュリティ: 内部情報の非公開', () => {
    it('google_sub等の内部IDを返さない', async () => {
      const res = await requestExternalUser(app, 'user-1');
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data).not.toHaveProperty('google_sub');
      expect(body.data).not.toHaveProperty('line_sub');
      expect(body.data).not.toHaveProperty('twitch_sub');
    });

    it('roleを返さない', async () => {
      const res = await requestExternalUser(app, 'user-1');
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data).not.toHaveProperty('role');
    });
  });
});
