import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { IdpEnv, RateLimitBinding } from '@0g0-id/shared';
import { authRateLimitMiddleware, externalApiRateLimitMiddleware } from './rate-limit';

const baseUrl = 'https://id.0g0.xyz';

function makeRateLimiter(success: boolean): RateLimitBinding {
  return { limit: vi.fn().mockResolvedValue({ success }) };
}

function makeBaseEnv(overrides?: Partial<IdpEnv>): Partial<IdpEnv> {
  return {
    DB: {} as D1Database,
    IDP_ORIGIN: 'https://id.0g0.xyz',
    USER_ORIGIN: 'https://user.0g0.xyz',
    ADMIN_ORIGIN: 'https://admin.0g0.xyz',
    GOOGLE_CLIENT_ID: 'mock-client-id',
    GOOGLE_CLIENT_SECRET: 'mock-client-secret',
    JWT_PRIVATE_KEY: 'mock-private-key',
    JWT_PUBLIC_KEY: 'mock-public-key',
    ...overrides,
  };
}

// ─── authRateLimitMiddleware ─────────────────────────────────────────────────

describe('authRateLimitMiddleware', () => {
  function buildApp(env: Partial<IdpEnv>) {
    const app = new Hono<{ Bindings: typeof env }>();
    app.use('/auth/*', authRateLimitMiddleware);
    app.get('/auth/login', (c) => c.json({ ok: true }));
    return {
      request: (path: string, headers?: Record<string, string>) =>
        app.request(
          new Request(`${baseUrl}${path}`, { headers }),
          undefined,
          env as unknown as Record<string, string>
        ),
    };
  }

  it('制限内のリクエスト → 200を返す', async () => {
    const app = buildApp(makeBaseEnv({ RATE_LIMITER_AUTH: makeRateLimiter(true) }));
    const res = await app.request('/auth/login');
    expect(res.status).toBe(200);
  });

  it('制限超過のリクエスト → 429を返す', async () => {
    const app = buildApp(makeBaseEnv({ RATE_LIMITER_AUTH: makeRateLimiter(false) }));
    const res = await app.request('/auth/login');
    expect(res.status).toBe(429);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('バインディング未設定の場合はスキップして通過する', async () => {
    const app = buildApp(makeBaseEnv({ RATE_LIMITER_AUTH: undefined }));
    const res = await app.request('/auth/login');
    expect(res.status).toBe(200);
  });

  it('cf-connecting-ip ヘッダーをキーとして limit() を呼ぶ', async () => {
    const rateLimiter = makeRateLimiter(true);
    const app = buildApp(makeBaseEnv({ RATE_LIMITER_AUTH: rateLimiter }));
    await app.request('/auth/login', { 'cf-connecting-ip': '1.2.3.4' });
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: '1.2.3.4' });
  });

  it('cf-connecting-ip がない場合は x-forwarded-for をキーとして使う', async () => {
    const rateLimiter = makeRateLimiter(true);
    const app = buildApp(makeBaseEnv({ RATE_LIMITER_AUTH: rateLimiter }));
    await app.request('/auth/login', { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' });
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: '10.0.0.1' });
  });

  it('IPが取得できない場合は "unknown" をキーとして使う', async () => {
    const rateLimiter = makeRateLimiter(true);
    const app = buildApp(makeBaseEnv({ RATE_LIMITER_AUTH: rateLimiter }));
    await app.request('/auth/login');
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: 'unknown' });
  });
});

// ─── externalApiRateLimitMiddleware ──────────────────────────────────────────

describe('externalApiRateLimitMiddleware', () => {
  function buildApp(env: Partial<IdpEnv>) {
    const app = new Hono<{ Bindings: typeof env }>();
    app.use('/api/external/*', externalApiRateLimitMiddleware);
    app.get('/api/external/users', (c) => c.json({ ok: true }));
    return {
      request: (path: string, headers?: Record<string, string>) =>
        app.request(
          new Request(`${baseUrl}${path}`, { headers }),
          undefined,
          env as unknown as Record<string, string>
        ),
    };
  }

  function basicAuthHeader(clientId: string, secret = 'secret'): string {
    return `Basic ${btoa(`${clientId}:${secret}`)}`;
  }

  it('制限内のリクエスト → 200を返す', async () => {
    const app = buildApp(makeBaseEnv({ RATE_LIMITER_EXTERNAL: makeRateLimiter(true) }));
    const res = await app.request('/api/external/users', {
      Authorization: basicAuthHeader('client-abc'),
    });
    expect(res.status).toBe(200);
  });

  it('制限超過のリクエスト → 429を返す', async () => {
    const app = buildApp(makeBaseEnv({ RATE_LIMITER_EXTERNAL: makeRateLimiter(false) }));
    const res = await app.request('/api/external/users', {
      Authorization: basicAuthHeader('client-abc'),
    });
    expect(res.status).toBe(429);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('バインディング未設定の場合はスキップして通過する', async () => {
    const app = buildApp(makeBaseEnv({ RATE_LIMITER_EXTERNAL: undefined }));
    const res = await app.request('/api/external/users');
    expect(res.status).toBe(200);
  });

  it('Basic認証の client_id をキーとして limit() を呼ぶ', async () => {
    const rateLimiter = makeRateLimiter(true);
    const app = buildApp(makeBaseEnv({ RATE_LIMITER_EXTERNAL: rateLimiter }));
    await app.request('/api/external/users', {
      Authorization: basicAuthHeader('my-client-id'),
    });
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: 'my-client-id' });
  });

  it('Authorizationヘッダーなしの場合は IP をキーとして使う', async () => {
    const rateLimiter = makeRateLimiter(true);
    const app = buildApp(makeBaseEnv({ RATE_LIMITER_EXTERNAL: rateLimiter }));
    await app.request('/api/external/users', { 'cf-connecting-ip': '5.6.7.8' });
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: '5.6.7.8' });
  });

  it('不正なBase64の場合は IP にフォールバックする', async () => {
    const rateLimiter = makeRateLimiter(true);
    const app = buildApp(makeBaseEnv({ RATE_LIMITER_EXTERNAL: rateLimiter }));
    await app.request('/api/external/users', {
      Authorization: 'Basic !!!invalid!!!',
      'cf-connecting-ip': '9.9.9.9',
    });
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: '9.9.9.9' });
  });

  it('コロンなし（不正なフォーマット）の場合は IP にフォールバックする', async () => {
    const rateLimiter = makeRateLimiter(true);
    const app = buildApp(makeBaseEnv({ RATE_LIMITER_EXTERNAL: rateLimiter }));
    await app.request('/api/external/users', {
      Authorization: `Basic ${btoa('no-colon-here')}`,
      'cf-connecting-ip': '9.9.9.9',
    });
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: '9.9.9.9' });
  });
});
