import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@0g0-id/shared', () => ({
  createLogger: vi.fn().mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('./middleware/auth', () => ({
  mcpAuthMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
  mcpRejectBannedUserMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
  mcpAdminMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock('./middleware/rate-limit', () => ({
  mcpRateLimitMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock('./mcp', async () => {
  const { Hono } = await import('hono');
  function MockMcpServer(this: { registerTool: ReturnType<typeof vi.fn> }) {
    this.registerTool = vi.fn();
  }
  return {
    McpServer: MockMcpServer,
    createMcpRoutes: vi.fn(() => new Hono()),
  };
});

vi.mock('./routes/well-known', async () => {
  const { Hono } = await import('hono');
  return { default: new Hono() };
});

vi.mock('./tools', () => ({
  listUsersTool: {},
  getUserTool: {},
  banUserTool: {},
  unbanUserTool: {},
  deleteUserTool: {},
  getUserLoginHistoryTool: {},
  getUserLoginStatsTool: {},
  getUserLoginTrendsTool: {},
  getUserProvidersTool: {},
  listUserSessionsTool: {},
  revokeUserSessionsTool: {},
  getUserOwnedServicesTool: {},
  getUserAuthorizedServicesTool: {},
  listServicesTool: {},
  getServiceTool: {},
  createServiceTool: {},
  deleteServiceTool: {},
  rotateServiceSecretTool: {},
  getAuditLogsTool: {},
  getAuditStatsTool: {},
  getSystemMetricsTool: {},
  getSuspiciousLoginsTool: {},
  getServiceTokenStatsTool: {},
}));

import { mcpAuthMiddleware } from './middleware/auth';
import { mcpRateLimitMiddleware } from './middleware/rate-limit';
import app from './index';

const mockEnv = {
  DB: {} as D1Database,
  IDP: { fetch: vi.fn() } as unknown as Fetcher,
  IDP_ORIGIN: 'https://id.0g0.xyz',
  MCP_ORIGIN: 'https://mcp.0g0.xyz',
};

describe('GET /health', () => {
  it('200を返してstatus okとworker名とtimestampを含む', async () => {
    const res = await app.request(
      'https://mcp.0g0.xyz/health',
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string; worker: string; timestamp: string }>();
    expect(body.status).toBe('ok');
    expect(body.worker).toBe('mcp');
    expect(typeof body.timestamp).toBe('string');
  });
});

describe('CORS', () => {
  it('MCP_ORIGINと一致するoriginのリクエストにAccess-Control-Allow-Originを付与する', async () => {
    const res = await app.request(
      'https://mcp.0g0.xyz/health',
      { headers: { Origin: 'https://mcp.0g0.xyz' } },
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://mcp.0g0.xyz');
  });

  it('MCP_ORIGINと一致しないoriginのリクエストにはAccess-Control-Allow-Originを付与しない', async () => {
    const res = await app.request(
      'https://mcp.0g0.xyz/health',
      { headers: { Origin: 'https://evil.com' } },
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('onError ハンドラ', () => {
  beforeEach(() => {
    vi.mocked(mcpRateLimitMiddleware).mockImplementation(async (_c, next) => next());
    vi.mocked(mcpAuthMiddleware).mockImplementation(async (_c, next) => next());
  });

  it('未処理の例外で500とINTERNAL_ERRORを返す', async () => {
    vi.mocked(mcpAuthMiddleware).mockImplementationOnce(async () => {
      throw new Error('unexpected error');
    });

    const res = await app.request(
      'https://mcp.0g0.xyz/mcp/test',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      mockEnv as unknown as Record<string, string>,
    );

    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error');
  });
});
