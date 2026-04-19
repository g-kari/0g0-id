import { describe, it, expect, vi } from "vitest";
import {
  logUpstreamDeprecation,
  UPSTREAM_DEPRECATION_LOG_MSG,
} from "./internal-secret-deprecation";
import type { Logger } from "./logger";

type MockFn = ReturnType<typeof vi.fn>;
type MockedLogger = { debug: MockFn; info: MockFn; warn: MockFn; error: MockFn };

function mockLogger(): Logger & MockedLogger {
  const logger: MockedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger as Logger & MockedLogger;
}

describe("logUpstreamDeprecation", () => {
  it("Deprecation ヘッダなしなら何もしない", () => {
    const logger = mockLogger();
    const res = new Response(null, { status: 200 });
    logUpstreamDeprecation(res, { method: "GET", path: "/api/users/me" }, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("Deprecation ヘッダがあれば warn を1件出す", () => {
    const logger = mockLogger();
    const res = new Response(null, {
      status: 200,
      headers: {
        Deprecation: "true",
        Link: '<https://github.com/g-kari/0g0-id/issues/156>; rel="deprecation"',
      },
    });
    logUpstreamDeprecation(res, { method: "POST", path: "/auth/exchange" }, logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(UPSTREAM_DEPRECATION_LOG_MSG, {
      deprecation: "true",
      link: '<https://github.com/g-kari/0g0-id/issues/156>; rel="deprecation"',
      method: "POST",
      path: "/auth/exchange",
    });
  });

  it("Link ヘッダだけ欠けていても Deprecation だけで検知する", () => {
    const logger = mockLogger();
    const res = new Response(null, {
      status: 200,
      headers: { Deprecation: "true" },
    });
    logUpstreamDeprecation(res, { method: "POST", path: "/auth/refresh" }, logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [, extra] = logger.warn.mock.calls[0] ?? [];
    expect(extra).toMatchObject({
      deprecation: "true",
      link: undefined,
      method: "POST",
      path: "/auth/refresh",
    });
  });

  it("ヘッダなしのエラーレスポンス（403 など拒否経路）では no-op", () => {
    const logger = mockLogger();
    const res = new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "denied" } }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
    logUpstreamDeprecation(res, { method: "POST", path: "/auth/exchange" }, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logger を省略した場合でも既定ロガーに落ちて落ちない", () => {
    // 既定ロガーは console.warn を出すので、全体が例外を投げないことだけ確認する。
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = new Response(null, {
      status: 200,
      headers: { Deprecation: "true" },
    });
    expect(() => logUpstreamDeprecation(res, { method: "GET", path: "/api/health" })).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("Response ボディには触れない（ストリーム未消費）", async () => {
    const logger = mockLogger();
    const res = new Response("payload", {
      status: 200,
      headers: { Deprecation: "true" },
    });
    logUpstreamDeprecation(res, { method: "GET", path: "/api/users/me" }, logger);
    // ヘルパ呼び出し後でもボディが未消費であることを確認
    expect(res.bodyUsed).toBe(false);
    await expect(res.text()).resolves.toBe("payload");
  });
});
