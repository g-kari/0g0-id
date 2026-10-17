import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { adminAuthRateLimitMiddleware, adminApiRateLimitMiddleware } from "./rate-limit";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    createLogger: vi.fn().mockReturnValue({
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

const baseUrl = "https://admin.example.com";

type MockRateLimiter = {
  limit: ReturnType<typeof vi.fn>;
};

type MockEnv = {
  IDP: Record<string, never>;
  IDP_ORIGIN: string;
  SELF_ORIGIN: string;
  SESSION_SECRET: string;
  INTERNAL_SERVICE_SECRET_SELF: string;
  RATE_LIMITER_ADMIN_AUTH?: MockRateLimiter;
  RATE_LIMITER_ADMIN_API?: MockRateLimiter;
};

function buildApp(
  middleware: typeof adminAuthRateLimitMiddleware,
  envOverrides?: Partial<MockEnv>,
) {
  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("*", middleware as any);
  app.get("/test", (c) => c.json({ ok: true }));
  const env: MockEnv = {
    IDP: {},
    IDP_ORIGIN: "https://id.example.com",
    SELF_ORIGIN: "https://admin.example.com",
    SESSION_SECRET: "test-secret-key-32chars-long!!!!",
    INTERNAL_SERVICE_SECRET_SELF: "test-internal-secret",
    ...envOverrides,
  };
  return { app, env };
}

describe("adminAuthRateLimitMiddleware", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("開発環境でバインディング未設定の場合はスキップして200を返す", async () => {
    const { app, env } = buildApp(adminAuthRateLimitMiddleware, {
      RATE_LIMITER_ADMIN_AUTH: undefined,
      SELF_ORIGIN: "http://localhost:5174",
    });
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      env as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
  });

  it("本番環境でバインディング未設定の場合は503を返す", async () => {
    const { app, env } = buildApp(adminAuthRateLimitMiddleware, {
      RATE_LIMITER_ADMIN_AUTH: undefined,
      SELF_ORIGIN: "https://admin.example.com",
    });
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      env as unknown as Record<string, string>,
    );
    expect(res.status).toBe(503);
  });

  it("レートリミット成功の場合は200を返す", async () => {
    const mockLimit = vi.fn().mockResolvedValue({ success: true });
    const { app, env } = buildApp(adminAuthRateLimitMiddleware, {
      RATE_LIMITER_ADMIN_AUTH: { limit: mockLimit },
    });
    const res = await app.request(
      new Request(`${baseUrl}/test`, {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
      undefined,
      env as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    expect(mockLimit).toHaveBeenCalledWith({ key: "1.2.3.4" });
  });

  it("レートリミット超過の場合は429を返す", async () => {
    const mockLimit = vi.fn().mockResolvedValue({ success: false });
    const { app, env } = buildApp(adminAuthRateLimitMiddleware, {
      RATE_LIMITER_ADMIN_AUTH: { limit: mockLimit },
    });
    const res = await app.request(
      new Request(`${baseUrl}/test`, {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      }),
      undefined,
      env as unknown as Record<string, string>,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("TOO_MANY_REQUESTS");
  });

  it("cf-connecting-ipがない場合はunknownをキーとして使用する", async () => {
    const mockLimit = vi.fn().mockResolvedValue({ success: true });
    const { app, env } = buildApp(adminAuthRateLimitMiddleware, {
      RATE_LIMITER_ADMIN_AUTH: { limit: mockLimit },
    });
    await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      env as unknown as Record<string, string>,
    );
    expect(mockLimit).toHaveBeenCalledWith({ key: "unknown" });
  });
});

describe("adminApiRateLimitMiddleware", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("レートリミット成功の場合は200を返す", async () => {
    const mockLimit = vi.fn().mockResolvedValue({ success: true });
    const { app, env } = buildApp(adminApiRateLimitMiddleware, {
      RATE_LIMITER_ADMIN_API: { limit: mockLimit },
    });
    const res = await app.request(
      new Request(`${baseUrl}/test`, {
        headers: { "cf-connecting-ip": "10.0.0.1" },
      }),
      undefined,
      env as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    expect(mockLimit).toHaveBeenCalledWith({ key: "10.0.0.1" });
  });

  it("レートリミット超過の場合は429を返す", async () => {
    const mockLimit = vi.fn().mockResolvedValue({ success: false });
    const { app, env } = buildApp(adminApiRateLimitMiddleware, {
      RATE_LIMITER_ADMIN_API: { limit: mockLimit },
    });
    const res = await app.request(
      new Request(`${baseUrl}/test`, {
        headers: { "cf-connecting-ip": "10.0.0.1" },
      }),
      undefined,
      env as unknown as Record<string, string>,
    );
    expect(res.status).toBe(429);
  });
});
