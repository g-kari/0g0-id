import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@0g0-id/shared', () => ({
  logger: () => async (_c: unknown, next: () => Promise<void>) => next(),
  securityHeaders: () => async (_c: unknown, next: () => Promise<void>) => next(),
  fetchWithAuth: vi.fn(),
  proxyResponse: vi.fn(),
  parseSession: vi.fn(),
  verifyAccessToken: vi.fn(),
}));

vi.mock('./middleware/csrf', () => ({
  adminCsrfMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('./middleware/cors', () => ({
  adminCorsMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { fetchWithAuth } from '@0g0-id/shared';
import app from './index';

const mockEnv = {
  IDP: { fetch: vi.fn() } as unknown as Fetcher,
  IDP_ORIGIN: 'https://id.0g0.xyz',
  SESSION_SECRET: 'test-secret',
};

describe('GET /api/health', () => {
  it('200を返してstatus okとworker名を含む', async () => {
    const res = await app.request(
      'https://admin.0g0.xyz/api/health',
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string; worker: string; timestamp: string }>();
    expect(body.status).toBe('ok');
    expect(body.worker).toBe('admin');
    expect(typeof body.timestamp).toBe('string');
  });
});

describe('onError ハンドラ', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('未処理の例外で500とINTERNAL_ERRORを返す', async () => {
    // fetchWithAuth をスローさせて /api/metrics 経由で app.onError を通過させる
    vi.mocked(fetchWithAuth).mockRejectedValue(new Error('unexpected network error'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.request(
      'https://admin.0g0.xyz/api/metrics',
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    consoleSpy.mockRestore();

    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error');
  });
});
