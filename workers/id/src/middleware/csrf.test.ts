import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { IdpEnv } from '@0g0-id/shared';
import { csrfMiddleware } from './csrf';

const mockEnv = {
  DB: {} as D1Database,
  IDP_ORIGIN: 'https://id.0g0.xyz',
  USER_ORIGIN: 'https://user.0g0.xyz',
  ADMIN_ORIGIN: 'https://admin.0g0.xyz',
  JWT_PRIVATE_KEY: 'mock-private-key',
  JWT_PUBLIC_KEY: 'mock-public-key',
  GOOGLE_CLIENT_ID: 'mock-client-id',
  GOOGLE_CLIENT_SECRET: 'mock-client-secret',
  BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
};

function buildApp() {
  const app = new Hono<{ Bindings: IdpEnv }>();
  app.use('/api/*', csrfMiddleware);
  app.get('/api/test', (c) => c.json({ ok: true }));
  app.post('/api/test', (c) => c.json({ ok: true }));
  return app;
}

describe('csrfMiddleware (id worker)', () => {
  const app = buildApp();
  const baseUrl = 'https://id.0g0.xyz';

  it('Originヘッダーなし → 403を返す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('IDP_ORIGIN からのOrigin → 200を返す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, { headers: { Origin: 'https://id.0g0.xyz' } }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(200);
  });

  it('USER_ORIGIN からのOrigin → 200を返す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, { headers: { Origin: 'https://user.0g0.xyz' } }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(200);
  });

  it('ADMIN_ORIGIN からのOrigin → 200を返す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, { headers: { Origin: 'https://admin.0g0.xyz' } }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(200);
  });

  it('Refererのみ（Originなし）→ 403を返す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, {
        headers: { Referer: 'https://user.0g0.xyz/profile' },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('外部ドメインからのOrigin → 403を返す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, {
        headers: { Origin: 'https://attacker.example.com' },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('不正な形式のOriginヘッダー → 403を返す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, { headers: { Origin: 'not-a-valid-url' } }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(403);
  });

  it('POSTリクエストでも同様に検証する', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, {
        method: 'POST',
        headers: { Origin: 'https://id.0g0.xyz' },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(200);
  });

  it('EXTRA_BFF_ORIGINS に含まれるオリジン → 200を返す', async () => {
    const envWithExtra = {
      ...mockEnv,
      EXTRA_BFF_ORIGINS: 'https://external.example.com,https://another.example.com',
    };
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, {
        headers: { Origin: 'https://external.example.com' },
      }),
      undefined,
      envWithExtra as unknown as Record<string, string>
    );
    expect(res.status).toBe(200);
  });

  it('EXTRA_BFF_ORIGINS に含まれないオリジン → 403を返す', async () => {
    const envWithExtra = {
      ...mockEnv,
      EXTRA_BFF_ORIGINS: 'https://external.example.com',
    };
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, {
        headers: { Origin: 'https://attacker.example.com' },
      }),
      undefined,
      envWithExtra as unknown as Record<string, string>
    );
    expect(res.status).toBe(403);
  });

  it('EXTRA_BFF_ORIGINS 未設定で外部オリジン → 403を返す', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, {
        headers: { Origin: 'https://external.example.com' },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(403);
  });
});
