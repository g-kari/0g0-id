import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { createRateLimitMiddleware } from "./rate-limit";
import type { RateLimitBinding } from "../types";

type TestEnv = {
  RATE_LIMITER?: RateLimitBinding;
  ORIGIN: string;
};

function makeRateLimiter(success: boolean): RateLimitBinding {
  return { limit: vi.fn().mockResolvedValue({ success }) };
}

const baseUrl = "https://test.example.com";

function buildApp(env: Partial<TestEnv>) {
  const middleware = createRateLimitMiddleware<TestEnv>({
    bindingName: "RATE_LIMITER",
    getBinding: (e) => e.RATE_LIMITER,
    getKey: (c) => c.req.raw.headers.get("cf-connecting-ip") ?? "unknown",
    errorMessage: "Too many requests.",
    isProduction: (e) => e.ORIGIN?.startsWith("https://") ?? false,
  });
  const app = new Hono<{ Bindings: TestEnv }>();
  app.use("*", middleware);
  app.get("/test", (c) => c.json({ ok: true }));
  return {
    request: (path: string, headers?: Record<string, string>) =>
      app.request(
        new Request(`${baseUrl}${path}`, { headers }),
        undefined,
        env as unknown as Record<string, string>,
      ),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("createRateLimitMiddleware", () => {
  it("制限内のリクエスト → 200を返す", async () => {
    const app = buildApp({ RATE_LIMITER: makeRateLimiter(true), ORIGIN: "https://example.com" });
    const res = await app.request("/test", { "cf-connecting-ip": "1.2.3.4" });
    expect(res.status).toBe(200);
  });

  it("制限超過のリクエスト → 429を返す", async () => {
    const app = buildApp({ RATE_LIMITER: makeRateLimiter(false), ORIGIN: "https://example.com" });
    const res = await app.request("/test", { "cf-connecting-ip": "1.2.3.4" });
    expect(res.status).toBe(429);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("TOO_MANY_REQUESTS");
    expect(body.error.message).toBe("Too many requests.");
  });

  it("制限超過のレスポンスに Retry-After ヘッダーが含まれる", async () => {
    const app = buildApp({ RATE_LIMITER: makeRateLimiter(false), ORIGIN: "https://example.com" });
    const res = await app.request("/test");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("カスタム retryAfterSeconds が反映される", async () => {
    const middleware = createRateLimitMiddleware<TestEnv>({
      bindingName: "RATE_LIMITER",
      getBinding: (e) => e.RATE_LIMITER,
      getKey: () => "key",
      errorMessage: "Too many.",
      retryAfterSeconds: 120,
    });
    const app = new Hono<{ Bindings: TestEnv }>();
    app.use("*", middleware);
    app.get("/test", (c) => c.json({ ok: true }));
    const env = { RATE_LIMITER: makeRateLimiter(false), ORIGIN: "https://example.com" };
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      env as unknown as Record<string, string>,
    );
    expect(res.headers.get("Retry-After")).toBe("120");
  });

  it("開発環境でバインディング未設定の場合はスキップして通過する", async () => {
    const app = buildApp({ RATE_LIMITER: undefined, ORIGIN: "http://localhost" });
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("本番環境でバインディング未設定の場合は503を返す", async () => {
    const app = buildApp({ RATE_LIMITER: undefined, ORIGIN: "https://example.com" });
    const res = await app.request("/test");
    expect(res.status).toBe(503);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("cf-connecting-ip をキーとして limit() を呼ぶ", async () => {
    const rateLimiter = makeRateLimiter(true);
    const app = buildApp({ RATE_LIMITER: rateLimiter, ORIGIN: "https://example.com" });
    await app.request("/test", { "cf-connecting-ip": "1.2.3.4" });
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: "1.2.3.4" });
  });

  it('IPがない場合は "unknown" をキーとして使う', async () => {
    const rateLimiter = makeRateLimiter(true);
    const app = buildApp({ RATE_LIMITER: rateLimiter, ORIGIN: "https://example.com" });
    await app.request("/test");
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: "unknown" });
  });

  it("非同期 getKey をサポートする", async () => {
    const rateLimiter = makeRateLimiter(true);
    const middleware = createRateLimitMiddleware<TestEnv>({
      bindingName: "RATE_LIMITER",
      getBinding: (e) => e.RATE_LIMITER,
      getKey: async () => "async-key",
      errorMessage: "Too many.",
    });
    const app = new Hono<{ Bindings: TestEnv }>();
    app.use("*", middleware);
    app.get("/test", (c) => c.json({ ok: true }));
    const env = { RATE_LIMITER: rateLimiter, ORIGIN: "https://example.com" };
    await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      env as unknown as Record<string, string>,
    );
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: "async-key" });
  });
});
