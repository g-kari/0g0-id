import { describe, it, expect, vi } from "vite-plus/test";

vi.mock("@0g0-id/shared", async (importOriginal) => ({
  ...(await importOriginal()),
  logger: () => async (_c: unknown, next: () => Promise<void>) => next(),
  securityHeaders: () => async (_c: unknown, next: () => Promise<void>) => next(),
  bodyLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
  bffCorsMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  // bffCsrfMiddleware はモックしない（実物を使う）
  createLogger: vi
    .fn()
    .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  validateBffEnv: vi.fn(),
  requireDbscBoundSession: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

import app from "./index";

const SELF_ORIGIN = "https://user.0g0.xyz";

const mockEnv = {
  IDP: { fetch: vi.fn() } as unknown as Fetcher,
  IDP_ORIGIN: "https://id.0g0.xyz",
  SELF_ORIGIN,
  SESSION_SECRET: "test-session-secret-for-unit-tests-only-32b",
  ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
};

function req(method: string, path: string, origin?: string): Request {
  const headers: Record<string, string> = {};
  if (origin) headers["Origin"] = origin;
  if (method === "PATCH" || method === "POST") headers["Content-Type"] = "application/json";
  return new Request(`${SELF_ORIGIN}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : "{}",
  });
}

const CSRF_PROTECTED_ROUTES: [string, string, string][] = [
  ["PATCH", "/api/me", "プロフィール更新"],
  ["DELETE", "/api/me", "アカウント削除"],
  ["DELETE", "/api/connections/550e8400-e29b-41d4-a716-446655440000", "サービス連携解除"],
  ["DELETE", "/api/providers/google", "プロバイダー連携解除"],
  ["DELETE", "/api/me/sessions/550e8400-e29b-41d4-a716-446655440000", "セッション失効"],
  ["DELETE", "/api/me/sessions", "全セッション失効"],
  ["DELETE", "/api/me/sessions/others", "他セッション失効"],
  ["DELETE", "/api/me/bff-sessions/550e8400-e29b-41d4-a716-446655440000", "BFFセッション失効"],
  ["POST", "/api/device/approve", "デバイス承認"],
  ["POST", "/api/device/verify", "デバイス検証"],
  ["POST", "/auth/logout", "ログアウト"],
  ["POST", "/auth/link", "SNS連携"],
];

describe("CSRF 拒否シナリオ統合テスト（user worker）", () => {
  describe("Originヘッダーなし → 403", () => {
    it.each(CSRF_PROTECTED_ROUTES)("%s %s（%s）— Originなしで403を返す", async (method, path) => {
      const res = await app.request(
        req(method, path),
        undefined,
        mockEnv as unknown as Record<string, string>,
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toBe("Origin header required");
    });
  });

  describe("外部Origin → 403", () => {
    it.each(CSRF_PROTECTED_ROUTES)("%s %s（%s）— 外部Originで403を返す", async (method, path) => {
      const res = await app.request(
        req(method, path, "https://evil.example.com"),
        undefined,
        mockEnv as unknown as Record<string, string>,
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toBe("Access from external services is not allowed");
    });
  });

  describe("他BFF Origin → 403", () => {
    it.each(CSRF_PROTECTED_ROUTES)("%s %s（%s）— admin Originで403を返す", async (method, path) => {
      const res = await app.request(
        req(method, path, "https://admin.0g0.xyz"),
        undefined,
        mockEnv as unknown as Record<string, string>,
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });

  describe("不正な形式のOrigin → 403", () => {
    it.each(CSRF_PROTECTED_ROUTES)("%s %s（%s）— 不正Originで403を返す", async (method, path) => {
      const res = await app.request(
        req(method, path, "not-a-valid-url"),
        undefined,
        mockEnv as unknown as Record<string, string>,
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toBe("Invalid Origin header");
    });
  });

  describe("安全なメソッド（GET）はCSRFスキップ", () => {
    it("GET /api/me — Originなしでも403にならない", async () => {
      const res = await app.request(
        req("GET", "/api/me"),
        undefined,
        mockEnv as unknown as Record<string, string>,
      );
      expect(res.status).not.toBe(403);
    });
  });
});
