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
    revokeUserTokens: vi.fn(),
    deleteMcpSessionsByUser: vi.fn(),
    revokeBffSessionByIdForUser: vi.fn(),
    revokeTokenByIdForUser: vi.fn(),
    listActiveSessionsByUserId: vi.fn(),
    listActiveBffSessionsByUserId: vi.fn(),
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
  revokeUserTokens,
  deleteMcpSessionsByUser,
  revokeBffSessionByIdForUser,
  revokeTokenByIdForUser,
  listActiveSessionsByUserId,
  listActiveBffSessionsByUserId,
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

const validUuid = "550e8400-e29b-41d4-a716-446655440000";

describe("Admin Sessions API", () => {
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
      const res = await sendRequest(app, "/api/users/user-001/bff-sessions", { withAuth: false });
      expect(res.status).toBe(401);
    });

    it("一般ユーザー → 403を返す", async () => {
      vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
      vi.mocked(findUserById).mockImplementation(async (_db, id) => {
        if (id === "user-regular") return mockRegularDbUser;
        if (id === "user-001") return mockTargetUser;
        return null;
      });

      const res = await sendRequest(app, "/api/users/user-001/bff-sessions");
      expect(res.status).toBe(403);
    });
  });

  // ===== GET /api/users/:id/tokens =====
  describe("GET /api/users/:id/tokens", () => {
    it("アクティブセッション一覧取得成功 → 200を返す", async () => {
      const mockSessions = [
        {
          id: "token-1",
          service_id: null,
          service_name: null,
          created_at: "2024-01-01T00:00:00Z",
          expires_at: "2024-02-01T00:00:00Z",
        },
        {
          id: "token-2",
          service_id: "svc-1",
          service_name: "Test Service",
          created_at: "2024-01-02T00:00:00Z",
          expires_at: "2024-02-02T00:00:00Z",
        },
      ];
      vi.mocked(listActiveSessionsByUserId).mockResolvedValue(mockSessions);

      const res = await sendRequest(app, "/api/users/user-001/tokens");
      expect(res.status).toBe(200);
      const body = await res.json<{ data: unknown[] }>();
      expect(body.data).toHaveLength(2);
      expect(listActiveSessionsByUserId).toHaveBeenCalledWith(expect.anything(), "user-001");
    });

    it("ユーザーが存在しない → 404を返す", async () => {
      const res = await sendRequest(app, "/api/users/nonexistent-id/tokens");
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  // ===== GET /api/users/:id/bff-sessions =====
  describe("GET /api/users/:id/bff-sessions", () => {
    it("BFFセッション一覧取得成功 → 200を返す", async () => {
      const mockSessions = [
        {
          id: "bff-1",
          user_id: "user-001",
          created_at: 1704067200,
          expires_at: 1706745600,
          user_agent: "Mozilla/5.0",
          ip: "127.0.0.1",
          bff_origin: "https://user.0g0.xyz",
          has_device_key: false,
          device_bound_at: null,
        },
      ];
      vi.mocked(listActiveBffSessionsByUserId).mockResolvedValue(mockSessions);

      const res = await sendRequest(app, "/api/users/user-001/bff-sessions");
      expect(res.status).toBe(200);
      const body = await res.json<{ data: unknown[] }>();
      expect(body.data).toHaveLength(1);
      expect(listActiveBffSessionsByUserId).toHaveBeenCalledWith(expect.anything(), "user-001");
    });

    it("セッションが空 → 空配列を返す", async () => {
      vi.mocked(listActiveBffSessionsByUserId).mockResolvedValue([]);

      const res = await sendRequest(app, "/api/users/user-001/bff-sessions");
      expect(res.status).toBe(200);
      const body = await res.json<{ data: unknown[] }>();
      expect(body.data).toHaveLength(0);
    });

    it("ユーザーが存在しない → 404を返す", async () => {
      const res = await sendRequest(app, "/api/users/nonexistent-id/bff-sessions");
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  // ===== DELETE /api/users/:id/bff-sessions/:sessionId =====
  describe("DELETE /api/users/:id/bff-sessions/:sessionId", () => {
    it("BFFセッション失効成功 → 204 + 監査ログが記録される", async () => {
      vi.mocked(revokeBffSessionByIdForUser).mockResolvedValue(1);

      const res = await sendRequest(app, `/api/users/user-001/bff-sessions/${validUuid}`, {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(204);

      expect(revokeBffSessionByIdForUser).toHaveBeenCalledWith(
        expect.anything(),
        validUuid,
        "user-001",
        "admin_action:admin-001",
      );
      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.bff_session_revoked",
          targetType: "user",
          targetId: "user-001",
          details: { sessionId: validUuid },
        }),
      );
    });

    it("セッションが見つからない → 404を返す", async () => {
      vi.mocked(revokeBffSessionByIdForUser).mockResolvedValue(0);

      const res = await sendRequest(app, `/api/users/user-001/bff-sessions/${validUuid}`, {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("不正なUUID形式 → 400を返す", async () => {
      const res = await sendRequest(app, "/api/users/user-001/bff-sessions/invalid-uuid", {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("ユーザーが存在しない → 404を返す", async () => {
      const res = await sendRequest(app, `/api/users/nonexistent-id/bff-sessions/${validUuid}`, {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("revokeBffSessionByIdForUser がエラー → 500 + 監査ログ（failure）が記録される", async () => {
      vi.mocked(revokeBffSessionByIdForUser).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, `/api/users/user-001/bff-sessions/${validUuid}`, {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(500);

      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.bff_session_revoked",
          status: "failure",
          targetId: "user-001",
          details: expect.objectContaining({ sessionId: validUuid }),
        }),
      );
    });

    it("Originヘッダーなし → 403を返す（CSRF保護）", async () => {
      const res = await sendRequest(app, `/api/users/user-001/bff-sessions/${validUuid}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });

    it("不正なOrigin → 403を返す（CSRF保護）", async () => {
      const res = await sendRequest(app, `/api/users/user-001/bff-sessions/${validUuid}`, {
        method: "DELETE",
        origin: "https://evil.example.com",
      });
      expect(res.status).toBe(403);
    });
  });

  // ===== DELETE /api/users/:id/tokens/:tokenId =====
  describe("DELETE /api/users/:id/tokens/:tokenId", () => {
    it("セッション失効成功 → 204 + 監査ログが記録される", async () => {
      vi.mocked(revokeTokenByIdForUser).mockResolvedValue(1);

      const res = await sendRequest(app, `/api/users/user-001/tokens/${validUuid}`, {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(204);

      expect(revokeTokenByIdForUser).toHaveBeenCalledWith(
        expect.anything(),
        validUuid,
        "user-001",
        "admin_action",
      );
      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.session_revoked",
          details: { tokenId: validUuid },
        }),
      );
    });

    it("トークンが見つからない → 404を返す", async () => {
      vi.mocked(revokeTokenByIdForUser).mockResolvedValue(0);

      const res = await sendRequest(app, `/api/users/user-001/tokens/${validUuid}`, {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("NOT_FOUND");
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

    it("revokeTokenByIdForUser がエラー → 500 + 監査ログ（failure）が記録される", async () => {
      vi.mocked(revokeTokenByIdForUser).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, `/api/users/user-001/tokens/${validUuid}`, {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(500);

      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.session_revoked",
          status: "failure",
          targetId: "user-001",
        }),
      );
    });
  });

  // ===== DELETE /api/users/:id/tokens (全セッション無効化) =====
  describe("DELETE /api/users/:id/tokens", () => {
    it("全セッション無効化成功 → 204 + 監査ログが記録される", async () => {
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

    it("ユーザーが存在しない → 404を返す", async () => {
      const res = await sendRequest(app, "/api/users/nonexistent-id/tokens", {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("revokeUserTokens がエラー → 500 + 監査ログ（failure）が記録される", async () => {
      vi.mocked(revokeUserTokens).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, "/api/users/user-001/tokens", {
        method: "DELETE",
        origin: "https://id.0g0.xyz",
      });
      expect(res.status).toBe(500);

      expect(logAdminAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "user.sessions_revoked",
          status: "failure",
          targetId: "user-001",
        }),
      );
    });
  });
});
