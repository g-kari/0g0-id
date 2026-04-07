import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// @0g0-id/shared の全関数をモック
vi.mock('@0g0-id/shared', () => ({
  createLogger: vi.fn().mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  sha256: vi.fn(),
  findServiceByClientId: vi.fn(),
  findUserById: vi.fn(),
  createDeviceCode: vi.fn(),
  findDeviceCodeByUserCode: vi.fn(),
  findDeviceCodeByHash: vi.fn(),
  approveDeviceCode: vi.fn(),
  denyDeviceCode: vi.fn(),
  tryUpdateDeviceCodePolledAt: vi.fn(),
  deleteDeviceCode: vi.fn(),
  deleteApprovedDeviceCode: vi.fn(),
  deleteExpiredDeviceCodes: vi.fn(),
  signIdToken: vi.fn(),
}));

// token-pair ユーティリティのモック
vi.mock('../utils/token-pair', () => ({
  issueTokenPair: vi.fn(),
  buildTokenResponse: vi.fn(),
}));

// scopes ユーティリティのモック
vi.mock('../utils/scopes', () => ({
  parseAllowedScopes: vi.fn((s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return [];
    }
  }),
  resolveEffectiveScope: vi.fn((scope: string | null) => scope ?? 'openid'),
}));

// middleware のモック（device.ts が参照するが handleDeviceCodeGrant では不使用）
vi.mock('../middleware/rate-limit', () => ({
  tokenApiRateLimitMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  deviceVerifyRateLimitMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  rejectServiceTokenMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  rejectBannedUserMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));

import {
  sha256,
  findServiceByClientId,
  findUserById,
  findDeviceCodeByHash,
  tryUpdateDeviceCodePolledAt,
  deleteApprovedDeviceCode,
  createDeviceCode,
  deleteExpiredDeviceCodes,
  signIdToken,
} from '@0g0-id/shared';

import { issueTokenPair, buildTokenResponse } from '../utils/token-pair';
import { resolveEffectiveScope } from '../utils/scopes';

import deviceRoutes, { handleDeviceCodeGrant } from './device';

// IdpEnv の必須フィールドをすべて含むモック環境
const mockEnv = {
  DB: {} as D1Database,
  IDP_ORIGIN: 'https://id.0g0.xyz',
  USER_ORIGIN: 'https://user.0g0.xyz',
  ADMIN_ORIGIN: 'https://admin.0g0.xyz',
  JWT_PRIVATE_KEY: 'mock-private-key',
  JWT_PUBLIC_KEY: 'mock-public-key',
  GOOGLE_CLIENT_ID: 'mock-google-client-id',
  GOOGLE_CLIENT_SECRET: 'mock-google-client-secret',
};

// テスト用 context ファクトリ
function makeContext() {
  return {
    env: mockEnv,
    req: {
      header: vi.fn().mockReturnValue(undefined),
    },
    json: vi.fn((data: unknown, status?: number, headers?: Record<string, string>) => {
      const responseHeaders = new Headers({ 'Content-Type': 'application/json' });
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          responseHeaders.set(k, v);
        }
      }
      return new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: responseHeaders,
      });
    }),
  };
}

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
  phone: null,
  address: null,
  role: 'user' as const,
  banned_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const mockDeviceCode = {
  id: 'dc-id',
  device_code_hash: 'hashed-device-code',
  user_code: 'ABCDEFGH',
  service_id: 'service-1',
  user_id: null as string | null,
  scope: null as string | null,
  approved_at: null as string | null,
  denied_at: null as string | null,
  expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  polled_at: null as string | null,
  created_at: '2024-01-01T00:00:00Z',
};

const approvedDeviceCode = {
  ...mockDeviceCode,
  approved_at: '2024-01-01T00:00:00Z',
  user_id: 'user-1',
  scope: 'openid profile',
};

const baseParams = {
  device_code: 'raw-device-code',
  client_id: 'test-client-id',
  grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
};

beforeEach(() => {
  vi.clearAllMocks();
  // デフォルトのモック設定
  vi.mocked(sha256).mockResolvedValue('hashed-device-code');
  vi.mocked(findServiceByClientId).mockResolvedValue(mockService as never);
  vi.mocked(findDeviceCodeByHash).mockResolvedValue(mockDeviceCode as never);
  vi.mocked(tryUpdateDeviceCodePolledAt).mockResolvedValue(true);
  vi.mocked(findUserById).mockResolvedValue(mockUser as never);
  vi.mocked(deleteApprovedDeviceCode).mockResolvedValue(true);
  vi.mocked(resolveEffectiveScope).mockReturnValue('openid profile');
  vi.mocked(issueTokenPair).mockResolvedValue({
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
  } as never);
  vi.mocked(buildTokenResponse).mockReturnValue({
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    token_type: 'Bearer',
    expires_in: 900,
  } as never);
});

// ===== handleDeviceCodeGrant =====
describe('handleDeviceCodeGrant', () => {
  it('device_code 未指定 → invalid_request + 400', async () => {
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, { client_id: 'test-client-id' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('client_id 未指定 → invalid_request + 400', async () => {
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, { device_code: 'raw-device-code' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('クライアント不存在 → invalid_client + 401', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(null);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_client');
  });

  it('デバイスコード不存在 → invalid_grant + 400', async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(null);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_grant');
  });

  it('別サービスのデバイスコード → invalid_grant + 400', async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue({
      ...mockDeviceCode,
      service_id: 'other-service-id',
    } as never);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_grant');
  });

  it('期限切れデバイスコード → invalid_grant + 400', async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue({
      ...mockDeviceCode,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    } as never);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_grant');
  });

  it('拒否済みデバイスコード → access_denied + 400', async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue({
      ...mockDeviceCode,
      denied_at: '2024-01-01T00:00:00Z',
    } as never);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('access_denied');
  });

  // ===== slow_down / Retry-After =====
  it('ポーリング間隔超過 → slow_down + 400', async () => {
    vi.mocked(tryUpdateDeviceCodePolledAt).mockResolvedValue(false);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('slow_down');
  });

  it('RFC 8628 §3.5: slow_down レスポンスに Retry-After ヘッダーが含まれる', async () => {
    vi.mocked(tryUpdateDeviceCodePolledAt).mockResolvedValue(false);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    // Retry-After ヘッダーにポーリング間隔（5秒）が設定されていること
    expect(res.headers.get('Retry-After')).toBe('5');
  });

  it('authorization_pending には Retry-After ヘッダーが含まれない', async () => {
    // tryUpdateDeviceCodePolledAt が true → まだ承認されていない（authorization_pending）
    vi.mocked(tryUpdateDeviceCodePolledAt).mockResolvedValue(true);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('authorization_pending');
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  it('未承認 → authorization_pending + 400', async () => {
    vi.mocked(tryUpdateDeviceCodePolledAt).mockResolvedValue(true);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('authorization_pending');
  });

  // ===== 承認後のケース =====
  it('承認済みだがユーザー不存在 → invalid_grant + 400', async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(approvedDeviceCode as never);
    vi.mocked(findUserById).mockResolvedValue(null);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_grant');
  });

  it('BAN済みユーザー → access_denied + 403', async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(approvedDeviceCode as never);
    vi.mocked(findUserById).mockResolvedValue({
      ...mockUser,
      banned_at: '2024-01-01T00:00:00Z',
    } as never);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('access_denied');
  });

  it('二重消費（deleteApprovedDeviceCode が false） → invalid_grant + 400', async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(approvedDeviceCode as never);
    vi.mocked(deleteApprovedDeviceCode).mockResolvedValue(false);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_grant');
  });

  it('承認済み → トークンレスポンスを返す', async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(approvedDeviceCode as never);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; token_type: string };
    expect(body.access_token).toBe('mock-access-token');
    expect(body.token_type).toBe('Bearer');
  });

  it('承認済み（openid スコープあり）→ signIdToken が呼ばれる', async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(approvedDeviceCode as never);
    vi.mocked(sha256)
      .mockResolvedValueOnce('hashed-device-code') // device_code ハッシュ
      .mockResolvedValueOnce('pairwise-sub'); // pairwise sub
    vi.mocked(signIdToken).mockResolvedValue('mock-id-token');
    vi.mocked(resolveEffectiveScope).mockReturnValue('openid profile');
    const c = makeContext();
    await handleDeviceCodeGrant(c as never, baseParams);
    expect(signIdToken).toHaveBeenCalled();
  });
});

// ===== POST /api/device/code — デバイス認可リクエスト =====
describe('POST /api/device/code — デバイス認可リクエスト', () => {
  const baseUrl = 'https://id.0g0.xyz';

  function buildDeviceApp() {
    const app = new Hono<{ Bindings: typeof mockEnv }>();
    app.route('/api/device', deviceRoutes);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findServiceByClientId).mockResolvedValue(mockService as never);
    vi.mocked(resolveEffectiveScope).mockImplementation((scope) => scope ?? 'openid');
    vi.mocked(createDeviceCode).mockResolvedValue(undefined as never);
    // deleteExpiredDeviceCodes は fire-and-forget なので Promise を返す必要がある
    vi.mocked(deleteExpiredDeviceCodes).mockResolvedValue(undefined as never);
  });

  it('全スコープが無効 → { error: invalid_scope } + 400', async () => {
    // resolveEffectiveScope が undefined を返す（全スコープ無効）
    vi.mocked(resolveEffectiveScope).mockReturnValue(undefined);
    const app = buildDeviceApp();
    const body = new URLSearchParams({
      client_id: 'test-client-id',
      scope: 'address',
    });
    const res = await app.request(
      new Request(`${baseUrl}/api/device/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
    const json = await res.json<{ error: string; error_description: string }>();
    expect(json.error).toBe('invalid_scope');
  });

  it('有効なスコープ → デバイスコードを発行して 200', async () => {
    vi.mocked(resolveEffectiveScope).mockReturnValue('openid profile');
    const app = buildDeviceApp();
    const body = new URLSearchParams({
      client_id: 'test-client-id',
      scope: 'openid profile',
    });
    const res = await app.request(
      new Request(`${baseUrl}/api/device/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(200);
    const json = await res.json<{ device_code: string; user_code: string }>();
    expect(json.device_code).toBeTruthy();
    expect(json.user_code).toBeTruthy();
  });
});
