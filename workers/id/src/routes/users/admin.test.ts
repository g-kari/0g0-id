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
    listUsers: vi.fn(),
    countUsers: vi.fn(),
    updateUserRoleWithRevocation: vi.fn(),
    banUserWithRevocation: vi.fn(),
    unbanUser: vi.fn(),
    revokeUserTokens: vi.fn(),
    deleteMcpSessionsByUser: vi.fn(),
    revokeTokenByIdForUser: vi.fn(),
    revokeBffSessionByIdForUser: vi.fn(),
    listActiveSessionsByUserId: vi.fn(),
    listActiveBffSessionsByUserId: vi.fn(),
    listServicesByOwner: vi.fn(),
    getUserProviders: vi.fn(),
    listUserConnections: vi.fn(),
    getLoginEventsByUserId: vi.fn(),
    getUserLoginProviderStats: vi.fn(),
    getUserDailyLoginTrends: vi.fn(),
    countServicesByOwner: vi.fn(),
    deleteUser: vi.fn(),
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

// _shared モジュールの部分モック
vi.mock("./_shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared")>();
  return {
    ...actual,
    performUserDeletion: vi.fn(),
  };
});

import {
  findUserById,
  verifyAccessToken,
  isAccessTokenRevoked,
  updateUserRoleWithRevocation,
  banUserWithRevocation,
  unbanUser,
  listUsers,
  countUsers,
  revokeUserTokens,
  deleteMcpSessionsByUser,
  revokeTokenByIdForUser,
} from "@0g0-id/shared";
import { logAdminAudit } from "../../lib/audit";
import { performUserDeletion } from "./_shared";
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

// BAN済みユーザー
const mockBannedUser = {
  ...mockTargetUser,
  id: "user-banned",
  banned_at: "2024-06-01T00:00:00Z",
};

// 対象管理者ユーザー（BAN禁止テスト用）
const mockTargetAdmin = {
  ...mockTargetUser,
  id: "admin-002",
  role: "admin" as const,
  email: "admin2@example.com",
};

// リクエストヘルパー
function makeRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    withAuth?: boolean;
    origin?: string;
  } = {},
) {
  const { method = "GET", body, withAuth = true, origin } = options;
  const headers: Record<string, string> = {};
  if (withAuth) headers["Authorization"] = "Bearer mock-token";
  if (origin) headers["Origin"] = origin;
  if (body) headers["Content-Type"] = "application/json";

  return new Request(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function sendRequest(
  app: ReturnType<typeof buildApp>,
  path: string,
  options: Parameters<typeof makeRequest>[1] = {},
) {
  return app.request(makeRequest(path, options), undefined, mockEnv);
}

describe("Admin Users API", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(isAccessTokenRevoked).mockResolvedValue(false);
    // findUserById: auth middleware は admin-001 を返し、ルートハンドラーは対象ユーザーを返す
    vi.mocked(findUserById).mockImplementation(async (_db, id) => {
      if (id === "admin-001") return mockAdminDbUser;
      if (id === "user-001") return mockTargetUser;
      if (id === "user-banned") return mockBannedUser;
      if (id === "admin-002") return mockTargetAdmin;
      return null;
    });
  });

  // ===== GET /api/users/:id =====
  describe("GET /api/users/:id", () => {
    it("ユーザー取得成功 → 200 + ユーザー詳細を返す", async () => {
      const res = await sendRequest(app, "/api/users/user-001");
      expect(res.status).toBe(200);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.id).toBe("user-001");
      expect(body.data.email).toBe("target@example.com");
      expect(body.data.name).toBe("Target User");
      expect(body.data.role).toBe("user");
      expect(body.data.banned_at).toBeNull();
      expect(body.data.created_at).toBe("2024-01-01T00:00:00Z");
      expect(body.data.updated_at).toBe("2024-01-01T00:00:00Z");
    });

    it("ユーザーが存在しない → 404を返す", async () => {
      const res = await sendRequest(app, "/api/users/nonexistent-id");
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  // ===== PATCH /api/users/:id/role =====
  describe("PATCH /api/users/:id/role", () => {
    it("ロール変更成功 → 200 + 監査ログが記録される", async () => {
      const updatedUser = { ...mockTargetUser, role: "admin" as const };
      vi.mocked(updateUserRoleWithRevocation).mockResolvedValue(updatedUser);

      const res = await sendRequest(app, "/api/users/user-001/role", {
        method: "PATCH",
        body: { role: "admin" },
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.id).toBe("user-001");

      expect(updateUserRoleWithRevocation).toHaveBeenCalledWith(
        expect.anything(),
        "user-001",
        "admin",
      );
      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.role_change",
          targetType: "user",
          targetId: "user-001",
          details: { from: "user", to: "admin" },
        }),
      );
    });

    it("自分自身のロール変更 → 403を返す", async () => {
      const res = await sendRequest(app, "/api/users/admin-001/role", {
        method: "PATCH",
        body: { role: "user" },
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.message).toBe("Cannot change your own role");
    });

    it("対象ユーザーが存在しない → 404を返す", async () => {
      const res = await sendRequest(app, "/api/users/nonexistent-id/role", {
        method: "PATCH",
        body: { role: "admin" },
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("同じロールの場合 → 200を返し、updateUserRoleWithRevocation は呼ばれない", async () => {
      const res = await sendRequest(app, "/api/users/user-001/role", {
        method: "PATCH",
        body: { role: "user" },
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.id).toBe("user-001");
      expect(updateUserRoleWithRevocation).not.toHaveBeenCalled();
    });

    it("updateUserRoleWithRevocation がエラー → 500 + 監査ログ（failure）が記録される", async () => {
      vi.mocked(updateUserRoleWithRevocation).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, "/api/users/user-001/role", {
        method: "PATCH",
        body: { role: "admin" },
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(500);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INTERNAL_ERROR");

      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.role_change",
          status: "failure",
          targetId: "user-001",
        }),
      );
    });
  });

  // ===== PATCH /api/users/:id/ban =====
  describe("PATCH /api/users/:id/ban", () => {
    it("BAN成功 → 200 + 監査ログが記録される", async () => {
      const bannedUser = { ...mockTargetUser, banned_at: "2024-06-01T00:00:00Z" };
      vi.mocked(banUserWithRevocation).mockResolvedValue(bannedUser);

      const res = await sendRequest(app, "/api/users/user-001/ban", {
        method: "PATCH",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.id).toBe("user-001");

      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.ban",
          targetType: "user",
          targetId: "user-001",
        }),
      );
    });

    it("自分自身をBAN → 403を返す", async () => {
      const res = await sendRequest(app, "/api/users/admin-001/ban", {
        method: "PATCH",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.message).toBe("Cannot ban yourself");
    });

    it("管理者ユーザーをBAN → 403を返す", async () => {
      const res = await sendRequest(app, "/api/users/admin-002/ban", {
        method: "PATCH",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.message).toBe("Cannot ban an admin user");
    });

    it("既にBAN済み → 409を返す", async () => {
      const res = await sendRequest(app, "/api/users/user-banned/ban", {
        method: "PATCH",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(409);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("CONFLICT");
    });

    it("banUserWithRevocation がエラー → 500 + 監査ログ（failure）が記録される", async () => {
      vi.mocked(banUserWithRevocation).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, "/api/users/user-001/ban", {
        method: "PATCH",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(500);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INTERNAL_ERROR");

      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.ban",
          status: "failure",
        }),
      );
    });
  });

  // ===== DELETE /api/users/:id/ban =====
  describe("DELETE /api/users/:id/ban", () => {
    it("BAN解除成功 → 200 + 監査ログが記録される", async () => {
      const unbannedUser = { ...mockBannedUser, banned_at: null };
      vi.mocked(unbanUser).mockResolvedValue(unbannedUser);

      const res = await sendRequest(app, "/api/users/user-banned/ban", {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.banned_at).toBeNull();

      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.unban",
          targetType: "user",
          targetId: "user-banned",
        }),
      );
    });

    it("BANされていないユーザー → 409を返す", async () => {
      const res = await sendRequest(app, "/api/users/user-001/ban", {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(409);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("CONFLICT");
    });
  });

  // ===== DELETE /api/users/:id =====
  describe("DELETE /api/users/:id", () => {
    it("ユーザー削除成功 → 204 + 監査ログが記録される", async () => {
      vi.mocked(performUserDeletion).mockResolvedValue(null);

      const res = await sendRequest(app, "/api/users/user-001", {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(204);

      expect(performUserDeletion).toHaveBeenCalledWith(expect.anything(), "user-001");
      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.delete",
          targetType: "user",
          targetId: "user-001",
        }),
      );
    });

    it("自分自身を削除 → 403を返す", async () => {
      const res = await sendRequest(app, "/api/users/admin-001", {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.message).toBe("Cannot delete yourself");
    });

    it("ユーザーが存在しない → 404を返す", async () => {
      const res = await sendRequest(app, "/api/users/nonexistent-id", {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  // ===== DELETE /api/users/:id/tokens =====
  describe("DELETE /api/users/:id/tokens", () => {
    it("全セッション無効化成功 → 204を返す", async () => {
      vi.mocked(revokeUserTokens).mockResolvedValue(undefined);
      vi.mocked(deleteMcpSessionsByUser).mockResolvedValue(undefined);

      const res = await sendRequest(app, "/api/users/user-001/tokens", {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(204);

      expect(revokeUserTokens).toHaveBeenCalledWith(expect.anything(), "user-001", "admin_action");
      expect(deleteMcpSessionsByUser).toHaveBeenCalledWith(expect.anything(), "user-001");
      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.sessions_revoked",
          targetType: "user",
          targetId: "user-001",
        }),
      );
    });
  });

  // ===== DELETE /api/users/:id/tokens/:tokenId =====
  describe("DELETE /api/users/:id/tokens/:tokenId", () => {
    it("セッション失効成功 → 204を返す", async () => {
      vi.mocked(revokeTokenByIdForUser).mockResolvedValue(1);

      const tokenId = "550e8400-e29b-41d4-a716-446655440000";
      const res = await sendRequest(app, `/api/users/user-001/tokens/${tokenId}`, {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(204);

      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.session_revoked",
          details: { tokenId },
        }),
      );
    });

    it("不正なUUID形式 → 400を返す", async () => {
      const res = await sendRequest(app, "/api/users/user-001/tokens/invalid-uuid", {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    });
  });

  // ===== GET /api/users =====
  describe("GET /api/users", () => {
    it("ユーザー一覧取得成功 → 200を返す", async () => {
      vi.mocked(listUsers).mockResolvedValue([mockTargetUser]);
      vi.mocked(countUsers).mockResolvedValue(1);

      const res = await sendRequest(app, "/api/users");
      expect(res.status).toBe(200);
      const body = await res.json<{ data: Record<string, unknown>[]; total: number }>();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe("user-001");
      expect(body.total).toBe(1);
    });
  });
});
