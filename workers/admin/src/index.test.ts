import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

vi.mock("./middleware/rate-limit", () => ({
  adminAuthRateLimitMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  adminApiRateLimitMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { mockFetchWithAuth, mockProxyResponse } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockProxyResponse: vi.fn(),
}));

vi.mock("@0g0-id/shared", async (importOriginal) => ({
  ...(await importOriginal()),
  logger: () => async (_c: unknown, next: () => Promise<void>) => next(),
  securityHeaders: () => async (_c: unknown, next: () => Promise<void>) => next(),
  bodyLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
  bffCorsMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  bffCsrfMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  fetchWithAuth: mockFetchWithAuth,
  proxyResponse: mockProxyResponse,
  proxyGet: (cookieName: string, buildUrl: (c: any) => string) => async (c: any) => {
    const res = await mockFetchWithAuth(c, cookieName, buildUrl(c));
    return mockProxyResponse(res);
  },
  parseSession: vi.fn().mockResolvedValue({
    session_id: "00000000-0000-0000-0000-000000000000",
    access_token: "mock-access-token",
    refresh_token: "mock-refresh-token",
    user: { id: "admin-123", email: "admin@example.com", name: "Admin", role: "admin" },
  }),
  verifyAccessToken: vi.fn(),
  validateBffEnv: vi.fn(),
  uuidParamMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("./middleware/csrf", () => ({
  adminCsrfMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("./middleware/cors", () => ({
  adminCorsMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { fetchWithAuth, parseSession } from "@0g0-id/shared";
import app from "./index";

const mockEnv = {
  IDP: { fetch: vi.fn() } as unknown as Fetcher,
  IDP_ORIGIN: "https://id.0g0.xyz",
  SESSION_SECRET: "test-session-secret-for-unit-tests-only-32b",
};

describe("GET /api/health", () => {
  it("200を返してstatus okとworker名を含む", async () => {
    const res = await app.request(
      "https://admin.0g0.xyz/api/health",
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string; worker: string; timestamp: string }>();
    expect(body.status).toBe("ok");
    expect(body.worker).toBe("admin");
    expect(typeof body.timestamp).toBe("string");
  });
});

describe("onError ハンドラ", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("未処理の例外で500とINTERNAL_ERRORを返す", async () => {
    // fetchWithAuth をスローさせて /api/metrics 経由で app.onError を通過させる
    vi.mocked(parseSession).mockResolvedValue({
      session_id: "00000000-0000-0000-0000-000000000000",
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      user: { id: "admin-123", email: "admin@example.com", name: "Admin", role: "admin" },
    });
    vi.mocked(fetchWithAuth).mockRejectedValue(new Error("unexpected network error"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request(
      "https://admin.0g0.xyz/api/metrics",
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    consoleSpy.mockRestore();

    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error");
  });
});

describe("onError の実 logger 統合 privacy 回帰", () => {
  const canary = "synthetic-only@example.invalid token=SYNTHETIC-ONLY-TOKEN";

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function requestFailure(error: Error): Promise<Response> {
    vi.mocked(parseSession).mockResolvedValue({
      session_id: "00000000-0000-0000-0000-000000000000",
      access_token: "synthetic-access-token",
      refresh_token: "synthetic-refresh-token",
      user: { id: "synthetic-admin", email: "admin@example.invalid", name: "Admin", role: "admin" },
    });
    vi.mocked(fetchWithAuth).mockRejectedValueOnce(error);
    return app.request(
      "https://admin.0g0.xyz/api/metrics",
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
  }

  async function expectFixedFailure(error: Error): Promise<void> {
    const response = await requestFailure(error);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ level: "error", ctx: "admin", msg: "Unhandled error" }),
    );
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.debug).not.toHaveBeenCalled();
    const output = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(output).not.toContain(canary);
  }

  it("例外の message・stack・cause・任意extraをconsoleへ渡さない", async () => {
    const error = new Error(canary, { cause: new Error(canary) });
    error.stack = `${canary}\n    at synthetic-only.invalid`;
    Object.assign(error, { details: { email: canary }, self: error });
    await expectFixedFailure(error);
  });

  it.each(["message", "stack", "cause", "name", "toJSON", "details"])(
    "例外の %s getterを参照せず固定500を返す",
    async (field) => {
      const error = new Error("Synthetic failure");
      error.stack = "Synthetic stack";
      const getter = vi.fn(() => {
        throw new Error(canary);
      });
      Object.defineProperty(error, field, { get: getter, configurable: true });
      await expectFixedFailure(error);
      expect(getter).not.toHaveBeenCalled();
    },
  );
});
