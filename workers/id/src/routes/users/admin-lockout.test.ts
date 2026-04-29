import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";

// @0g0-id/shared の全関数をモック
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    findUserById: vi.fn(),
    verifyAccessToken: vi.fn(),
    isAccessTokenRevoked: vi.fn().mockResolvedValue(false),
    createAdminAuditLog: vi.fn(),
    getAccountLockout: vi.fn(),
    clearLockout: vi.fn(),
  };
});

// audit モジュールのモック
vi.mock("../../lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/audit")>();
  return {
    ...actual,
    logAdminAudit: vi.fn(),
    extractErrorMessage: vi.fn().mockReturnValue("mock error"),
  };
});

import {
  findUserById,
  verifyAccessToken,
  isAccessTokenRevoked,
  getAccountLockout,
  clearLockout,
} from "@0g0-id/shared";
import { logAdminAudit } from "../../lib/audit";
import adminApp from "./admin";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

const baseUrl = "https://id.0g0.xyz";
const mockEnv = createMockIdpEnv();

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route("/api/users", adminApp);
  return app;
}

// 管理者トークンペイロード
const mockAdminPayload = {
  iss: "https://id.0g0.xyz",
  sub: "admin-001",
  aud: "https://id.0g0.xyz",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  jti: "jti-admin",
  kid: "key-1",
  email: "admin@example.com",
  role: "admin" as const,
};

// 管理者DBユーザー
const mockAdminDbUser = {
  id: "admin-001",
  google_sub: null,
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: "admin@example.com",
  email_verified: 1,
  name: "Admin",
  picture: null,
  phone: null,
  address: null,
  role: "admin" as const,
  banned_at: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

// 対象ユーザー（一般）
const mockTargetUser = {
  id: "user-001",
  google_sub: "g-1",
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: "target@example.com",
  email_verified: 1,
  name: "Target User",
  picture: null,
  phone: null,
  address: null,
  role: "user" as const,
  banned_at: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

// 一般ユーザートークンペイロード
const mockUserPayload = {
  ...mockAdminPayload,
  sub: "user-regular",
  email: "regular@example.com",
  role: "user" as const,
};

const mockRegularDbUser = {
  ...mockTargetUser,
  id: "user-regular",
  email: "regular@example.com",
  role: "user" as const,
};

// リクエストヘルパー
function makeRequest(
  path: string,
  options: {
    method?: string;
    withAuth?: boolean;
    origin?: string;
  } = {},
) {
  const { method = "GET", withAuth = true, origin } = options;
  const headers: Record<string, string> = {};
  if (withAuth) headers["Authorization"] = "Bearer mock-token";
  if (origin) headers["Origin"] = origin;

  return new Request(`${baseUrl}${path}`, {
    method,
    headers,
  });
}

async function sendRequest(
  app: ReturnType<typeof buildApp>,
  path: string,
  options: Parameters<typeof makeRequest>[1] = {},
) {
  return app.request(makeRequest(path, options), undefined, mockEnv);
}

describe("Admin Lockout API", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(isAccessTokenRevoked).mockResolvedValue(false);
    vi.mocked(findUserById).mockImplementation(async (_db, id) => {
      if (id === "admin-001") return mockAdminDbUser;
      if (id === "user-001") return mockTargetUser;
      return null;
    });
  });

  // ===== 認証・認可テスト =====
  describe("認証・認可", () => {
    it("Authorizationヘッダーなし → 401を返す", async () => {
      const res = await sendRequest(app, "/api/users/user-001/lockout", { withAuth: false });
      expect(res.status).toBe(401);
    });

    it("一般ユーザー → 403を返す", async () => {
      vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
      vi.mocked(findUserById).mockImplementation(async (_db, id) => {
        if (id === "user-regular") return mockRegularDbUser;
        if (id === "user-001") return mockTargetUser;
        return null;
      });

      const res = await sendRequest(app, "/api/users/user-001/lockout");
      expect(res.status).toBe(403);
    });
  });

  // ===== GET /api/users/:id/lockout =====
  describe("GET /api/users/:id/lockout", () => {
    it("ロックアウトなし → failed_attempts: 0 を返す", async () => {
      vi.mocked(getAccountLockout).mockResolvedValue(null);

      const res = await sendRequest(app, "/api/users/user-001/lockout");
      expect(res.status).toBe(200);
      const body = await res.json<{
        data: { user_id: string; failed_attempts: number; locked_until: string | null };
      }>();
      expect(body.data.user_id).toBe("user-001");
      expect(body.data.failed_attempts).toBe(0);
      expect(body.data.locked_until).toBeNull();
    });

    it("ロックアウト中（locked_until が未来） → is_locked: true を返す", async () => {
      const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
      vi.mocked(getAccountLockout).mockResolvedValue({
        user_id: "user-001",
        failed_attempts: 5,
        locked_until: futureDate,
        last_failed_at: "2024-06-01T00:00:00Z",
        updated_at: "2024-06-01T00:00:00Z",
      });

      const res = await sendRequest(app, "/api/users/user-001/lockout");
      expect(res.status).toBe(200);
      const body = await res.json<{ data: { is_locked: boolean; failed_attempts: number } }>();
      expect(body.data.is_locked).toBe(true);
      expect(body.data.failed_attempts).toBe(5);
    });

    it("ロックアウト期限切れ（locked_until が過去） → is_locked: false を返す", async () => {
      const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
      vi.mocked(getAccountLockout).mockResolvedValue({
        user_id: "user-001",
        failed_attempts: 3,
        locked_until: pastDate,
        last_failed_at: "2024-06-01T00:00:00Z",
        updated_at: "2024-06-01T00:00:00Z",
      });

      const res = await sendRequest(app, "/api/users/user-001/lockout");
      expect(res.status).toBe(200);
      const body = await res.json<{ data: { is_locked: boolean } }>();
      expect(body.data.is_locked).toBe(false);
    });

    it("ユーザーが存在しない → 404を返す", async () => {
      const res = await sendRequest(app, "/api/users/nonexistent-id/lockout");
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  // ===== DELETE /api/users/:id/lockout =====
  describe("DELETE /api/users/:id/lockout", () => {
    it("ロックアウト解除成功 → 200 + 監査ログが記録される", async () => {
      vi.mocked(clearLockout).mockResolvedValue(undefined);

      const res = await sendRequest(app, "/api/users/user-001/lockout", {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ data: { message: string } }>();
      expect(body.data.message).toBe("Lockout cleared");

      expect(clearLockout).toHaveBeenCalledWith(expect.anything(), "user-001");
      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.lockout_clear",
          targetType: "user",
          targetId: "user-001",
        }),
      );
    });

    it("ユーザーが存在しない → 404を返す", async () => {
      const res = await sendRequest(app, "/api/users/nonexistent-id/lockout", {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("Originヘッダーなし → 403を返す（CSRF保護）", async () => {
      const res = await sendRequest(app, "/api/users/user-001/lockout", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });

    it("不正なOrigin → 403を返す（CSRF保護）", async () => {
      const res = await sendRequest(app, "/api/users/user-001/lockout", {
        method: "DELETE",
        origin: "https://evil.example.com",
      });
      expect(res.status).toBe(403);
    });
  });
});
