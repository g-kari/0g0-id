import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@0g0-id/shared', () => ({
  findServiceByClientId: vi.fn(),
  sha256: vi.fn(),
  timingSafeEqual: vi.fn(),
}));

import { findServiceByClientId, sha256, timingSafeEqual } from '@0g0-id/shared';
import { authenticateService, serviceAuthMiddleware } from './service-auth';
import type { Service } from '@0g0-id/shared';

const mockService: Service = {
  id: 'service-1',
  name: 'Test Service',
  client_id: 'test-client',
  client_secret_hash: 'hash-abc123',
  allowed_scopes: '["openid","profile"]',
  owner_user_id: 'user-1',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const mockDb = {} as D1Database;

// ===== authenticateService =====
describe('authenticateService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('Authorizationヘッダーが未設定の場合はnullを返す', async () => {
    expect(await authenticateService(mockDb, undefined)).toBeNull();
  });

  it('Basic以外の認証スキームはnullを返す', async () => {
    expect(await authenticateService(mockDb, 'Bearer token123')).toBeNull();
  });

  it('無効なBase64はnullを返す', async () => {
    // atobが失敗するように不正なBase64文字列を渡す
    expect(await authenticateService(mockDb, 'Basic !!!invalid!!!')).toBeNull();
  });

  it('コロンなしの認証情報はnullを返す', async () => {
    // btoa('nocolin') → コロンなし
    const encoded = btoa('nocolon');
    expect(await authenticateService(mockDb, `Basic ${encoded}`)).toBeNull();
  });

  it('サービスが見つからない場合はnullを返す', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(null);
    const encoded = btoa('test-client:secret');
    expect(await authenticateService(mockDb, `Basic ${encoded}`)).toBeNull();
    expect(findServiceByClientId).toHaveBeenCalledWith(mockDb, 'test-client');
  });

  it('シークレットが一致しない場合はnullを返す', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(mockService);
    vi.mocked(sha256).mockResolvedValue('wrong-hash');
    vi.mocked(timingSafeEqual).mockReturnValue(false);
    const encoded = btoa('test-client:wrong-secret');
    expect(await authenticateService(mockDb, `Basic ${encoded}`)).toBeNull();
    expect(sha256).toHaveBeenCalledWith('wrong-secret');
    expect(timingSafeEqual).toHaveBeenCalledWith('wrong-hash', mockService.client_secret_hash);
  });

  it('正常認証でサービスを返す', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(mockService);
    vi.mocked(sha256).mockResolvedValue('hash-abc123');
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    const encoded = btoa('test-client:correct-secret');
    const result = await authenticateService(mockDb, `Basic ${encoded}`);
    expect(result).toBe(mockService);
    expect(sha256).toHaveBeenCalledWith('correct-secret');
  });

  it('クレデンシャルのコロンが複数ある場合は最初のコロンで分割する', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(mockService);
    vi.mocked(sha256).mockResolvedValue('hash-abc123');
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    // client_id: 'test-client', password: 'pass:with:colons'
    const encoded = btoa('test-client:pass:with:colons');
    await authenticateService(mockDb, `Basic ${encoded}`);
    expect(findServiceByClientId).toHaveBeenCalledWith(mockDb, 'test-client');
    expect(sha256).toHaveBeenCalledWith('pass:with:colons');
  });

  it('DB障害時はエラーをthrowする', async () => {
    vi.mocked(findServiceByClientId).mockRejectedValue(new Error('DB connection failed'));
    const encoded = btoa('test-client:secret');
    await expect(authenticateService(mockDb, `Basic ${encoded}`)).rejects.toThrow(
      'Service authentication failed due to internal error',
    );
  });
});

// ===== serviceAuthMiddleware =====
describe('serviceAuthMiddleware', () => {
  const baseUrl = 'https://id.0g0.xyz';
  const mockEnv = { DB: mockDb };

  function buildApp() {
    const app = new Hono<{ Bindings: typeof mockEnv; Variables: { service: Service } }>();
    app.use('/external/*', serviceAuthMiddleware);
    app.get('/external/users', (c) => {
      const service = c.get('service');
      return c.json({ ok: true, serviceId: service.id });
    });
    return app;
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('DB障害時は500を返す', async () => {
    vi.mocked(findServiceByClientId).mockRejectedValue(new Error('DB error'));
    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/external/users`, {
        headers: { Authorization: `Basic ${btoa('test-client:secret')}` },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('認証失敗時は401を返す', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(null);
    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/external/users`, {
        headers: { Authorization: `Basic ${btoa('unknown-client:wrong')}` },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('Authorizationヘッダーなしは401を返す', async () => {
    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/external/users`),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(401);
  });

  it('正常認証でserviceをcontextにセットしてnext()を呼び出す', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(mockService);
    vi.mocked(sha256).mockResolvedValue('hash-abc123');
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/external/users`, {
        headers: { Authorization: `Basic ${btoa('test-client:correct-secret')}` },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; serviceId: string }>();
    expect(body.ok).toBe(true);
    expect(body.serviceId).toBe(mockService.id);
  });
});
