import { describe, it, expect, vi } from "vite-plus/test";

vi.mock("./middleware/rate-limit", () => ({
  adminAuthRateLimitMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  adminApiRateLimitMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

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

const SELF_ORIGIN = "https://admin.0g0.xyz";
const DUMMY_UUID = "550e8400-e29b-41d4-a716-446655440000";

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
  ["POST", "/api/services", "サービス作成"],
  ["PATCH", `/api/services/${DUMMY_UUID}`, "サービス更新"],
  ["DELETE", `/api/services/${DUMMY_UUID}`, "サービス削除"],
  ["POST", `/api/services/${DUMMY_UUID}/redirect-uris`, "リダイレクトURI追加"],
  ["POST", `/api/services/${DUMMY_UUID}/rotate-secret`, "シークレットローテーション"],
  ["PATCH", `/api/services/${DUMMY_UUID}/owner`, "オーナー変更"],
  ["DELETE", `/api/services/${DUMMY_UUID}/redirect-uris/${DUMMY_UUID}`, "リダイレクトURI削除"],
  ["DELETE", `/api/services/${DUMMY_UUID}/users/${DUMMY_UUID}`, "サービスユーザー削除"],
  ["PATCH", `/api/users/${DUMMY_UUID}/role`, "ユーザーロール変更"],
  ["PATCH", `/api/users/${DUMMY_UUID}/ban`, "ユーザーBAN"],
  ["DELETE", `/api/users/${DUMMY_UUID}/ban`, "BAN解除"],
  ["DELETE", `/api/users/${DUMMY_UUID}/lockout`, "ロックアウト解除"],
  ["DELETE", `/api/users/${DUMMY_UUID}`, "ユーザー削除"],
  ["DELETE", `/api/users/${DUMMY_UUID}/tokens`, "全トークン失効"],
  ["DELETE", `/api/users/${DUMMY_UUID}/tokens/${DUMMY_UUID}`, "トークン個別失効"],
  ["DELETE", `/api/users/${DUMMY_UUID}/bff-sessions/${DUMMY_UUID}`, "BFFセッション失効"],
  ["POST", "/auth/logout", "ログアウト"],
];

describe("CSRF 拒否シナリオ統合テスト（admin worker）", () => {
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
    it.each(CSRF_PROTECTED_ROUTES)("%s %s（%s）— user Originで403を返す", async (method, path) => {
      const res = await app.request(
        req(method, path, "https://user.0g0.xyz"),
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
    it("GET /api/health — Originなしでも403にならない", async () => {
      const res = await app.request(
        req("GET", "/api/health"),
        undefined,
        mockEnv as unknown as Record<string, string>,
      );
      expect(res.status).not.toBe(403);
    });
  });
});
