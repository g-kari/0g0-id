import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { mcpRateLimitMiddleware } from './rate-limit';

vi.mock('@0g0-id/shared', () => ({
  createLogger: vi.fn().mockReturnValue({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const baseUrl = 'https://mcp.example.com';

type MockRateLimiter = {
  limit: ReturnType<typeof vi.fn>;
};

type MockEnv = {
  DB: Record<string, never>;
  IDP: Record<string, never>;
  IDP_ORIGIN: string;
  MCP_ORIGIN: string;
  RATE_LIMITER_MCP?: MockRateLimiter;
};

function buildApp(envOverrides?: Partial<MockEnv>) {
  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('*', mcpRateLimitMiddleware as any);
  app.get('/test', (c) => c.json({ ok: true }));
  const env: MockEnv = {
    DB: {},
    IDP: {},
    IDP_ORIGIN: 'https://id.example.com',
    MCP_ORIGIN: 'https://mcp.example.com',
    ...envOverrides,
  };
  return { app, env };
}

describe('mcpRateLimitMiddleware', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('RATE_LIMITER_MCPバインディングがない場合はスキップして200を返す', async () => {
    const { app, env } = buildApp({ RATE_LIMITER_MCP: undefined });
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      env as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
  });

  it('レートリミット成功の場合は200を返す', async () => {
    const mockLimit = vi.fn().mockResolvedValue({ success: true });
    const { app, env } = buildApp({ RATE_LIMITER_MCP: { limit: mockLimit } });

    const res = await app.request(
      new Request(`${baseUrl}/test`, {
        headers: { 'cf-connecting-ip': '1.2.3.4' },
      }),
      undefined,
      env as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    expect(mockLimit).toHaveBeenCalledWith({ key: '1.2.3.4' });
  });

  it('レートリミット超過の場合は429を返す', async () => {
    const mockLimit = vi.fn().mockResolvedValue({ success: false });
    const { app, env } = buildApp({ RATE_LIMITER_MCP: { limit: mockLimit } });

    const res = await app.request(
      new Request(`${baseUrl}/test`, {
        headers: { 'cf-connecting-ip': '1.2.3.4' },
      }),
      undefined,
      env as unknown as Record<string, string>,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(body.error.message).toContain('Too many requests');
  });

  it('cf-connecting-ipがない場合はunknownをキーとして使用する', async () => {
    const mockLimit = vi.fn().mockResolvedValue({ success: true });
    const { app, env } = buildApp({ RATE_LIMITER_MCP: { limit: mockLimit } });

    await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      env as unknown as Record<string, string>,
    );
    expect(mockLimit).toHaveBeenCalledWith({ key: 'unknown' });
  });

  it('異なるIPは独立したレートリミットキーで処理される', async () => {
    const mockLimit = vi.fn().mockResolvedValue({ success: true });
    const { app, env } = buildApp({ RATE_LIMITER_MCP: { limit: mockLimit } });

    await app.request(
      new Request(`${baseUrl}/test`, { headers: { 'cf-connecting-ip': '10.0.0.1' } }),
      undefined,
      env as unknown as Record<string, string>,
    );
    await app.request(
      new Request(`${baseUrl}/test`, { headers: { 'cf-connecting-ip': '10.0.0.2' } }),
      undefined,
      env as unknown as Record<string, string>,
    );

    expect(mockLimit).toHaveBeenNthCalledWith(1, { key: '10.0.0.1' });
    expect(mockLimit).toHaveBeenNthCalledWith(2, { key: '10.0.0.2' });
  });
});
