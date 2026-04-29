import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    findServiceById: vi.fn(),
    findUserById: vi.fn(),
    generateClientSecret: vi.fn(),
    sha256: vi.fn(),
    rotateClientSecret: vi.fn(),
    transferServiceOwnership: vi.fn(),
    listUsersAuthorizedForService: vi.fn(),
    countUsersAuthorizedForService: vi.fn(),
    revokeUserServiceTokens: vi.fn(),
    verifyAccessToken: vi.fn(),
    isAccessTokenRevoked: vi.fn().mockResolvedValue(false),
  };
});

vi.mock("../../lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/audit")>();
  return {
    ...actual,
    logAdminAudit: vi.fn(),
    extractErrorMessage: vi.fn().mockReturnValue("mock error"),
  };
});

import {
  findServiceById,
  findUserById,
  generateClientSecret,
  sha256,
  rotateClientSecret,
  transferServiceOwnership,
  listUsersAuthorizedForService,
  countUsersAuthorizedForService,
  revokeUserServiceTokens,
  verifyAccessToken,
  isAccessTokenRevoked,
} from "@0g0-id/shared";
import servicesApp from "./index";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

const baseUrl = "https://id.0g0.xyz";
const mockEnv = createMockIdpEnv();

const SERVICE_ID = "a0000000-0000-0000-0000-000000000001";
const USER_ID = "b0000000-0000-0000-0000-000000000001";

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

const mockService = {
  id: SERVICE_ID,
  name: "Test Service",
  client_id: "cid_test",
  client_secret_hash: "hash_test",
  allowed_scopes: '["profile","email"]',
  owner_user_id: "admin-001",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const mockUser = {
  id: USER_ID,
  google_sub: "g-1",
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: "user@example.com",
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

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route("/api/services", servicesApp);
  return app;
}

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

describe("Services Admin Operations API", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(isAccessTokenRevoked).mockResolvedValue(false);
    vi.mocked(findUserById).mockImplementation(async (_db, id) => {
      if (id === "admin-001") return mockAdminDbUser;
      if (id === USER_ID) return mockUser;
      return null;
    });
    vi.mocked(generateClientSecret).mockReturnValue("new_secret");
    vi.mocked(sha256).mockResolvedValue("new_hash");
  });

  describe("POST /api/services/:id/rotate-secret", () => {
    const origin = "https://admin.0g0.xyz";

    it("200: シークレットをローテーション", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(rotateClientSecret).mockResolvedValue({
        ...mockService,
        client_secret_hash: "new_hash",
        updated_at: "2024-06-01T00:00:00Z",
      });

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/rotate-secret`, {
        method: "POST",
        origin,
      });
      expect(res.status).toBe(200);
      const json = await res.json<{
        data: Record<string, unknown> & Record<string, unknown>[];
        total?: number;
      }>();
      expect(json.data.client_secret).toBe("new_secret");
      expect(json.data.client_id).toBe("cid_test");
    });

    it("404: サービスが見つからない", async () => {
      vi.mocked(findServiceById).mockResolvedValue(null);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/rotate-secret`, {
        method: "POST",
        origin,
      });
      expect(res.status).toBe(404);
    });

    it("404: rotateClientSecretがnullを返す", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(rotateClientSecret).mockResolvedValue(null);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/rotate-secret`, {
        method: "POST",
        origin,
      });
      expect(res.status).toBe(404);
    });

    it("403: CSRFエラー", async () => {
      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/rotate-secret`, {
        method: "POST",
      });
      expect(res.status).toBe(403);
    });

    it("500: findServiceByIdのDBエラー", async () => {
      vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/rotate-secret`, {
        method: "POST",
        origin,
      });
      expect(res.status).toBe(500);
    });

    it("500: rotateClientSecretのDBエラー", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(rotateClientSecret).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/rotate-secret`, {
        method: "POST",
        origin,
      });
      expect(res.status).toBe(500);
    });
  });

  describe("PATCH /api/services/:id/owner", () => {
    const origin = "https://admin.0g0.xyz";

    it("200: 所有権を移譲", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(transferServiceOwnership).mockResolvedValue({
        ...mockService,
        owner_user_id: USER_ID,
        updated_at: "2024-06-01T00:00:00Z",
      });

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/owner`, {
        method: "PATCH",
        body: { new_owner_user_id: USER_ID },
        origin,
      });
      expect(res.status).toBe(200);
      const json = await res.json<{
        data: Record<string, unknown> & Record<string, unknown>[];
        total?: number;
      }>();
      expect(json.data.owner_user_id).toBe(USER_ID);
    });

    it("404: サービスが見つからない", async () => {
      vi.mocked(findServiceById).mockResolvedValue(null);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/owner`, {
        method: "PATCH",
        body: { new_owner_user_id: USER_ID },
        origin,
      });
      expect(res.status).toBe(404);
    });

    it("404: 新しいオーナーが見つからない", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(findUserById).mockImplementation(async (_db, id) => {
        if (id === "admin-001") return mockAdminDbUser;
        return null;
      });

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/owner`, {
        method: "PATCH",
        body: { new_owner_user_id: "nonexistent-user" },
        origin,
      });
      expect(res.status).toBe(404);
    });

    it("404: transferServiceOwnershipがnullを返す", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(transferServiceOwnership).mockResolvedValue(null);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/owner`, {
        method: "PATCH",
        body: { new_owner_user_id: USER_ID },
        origin,
      });
      expect(res.status).toBe(404);
    });

    it("400: new_owner_user_id未指定", async () => {
      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/owner`, {
        method: "PATCH",
        body: {},
        origin,
      });
      expect(res.status).toBe(400);
    });

    it("403: CSRFエラー", async () => {
      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/owner`, {
        method: "PATCH",
        body: { new_owner_user_id: USER_ID },
      });
      expect(res.status).toBe(403);
    });

    it("500: DBエラー", async () => {
      vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/owner`, {
        method: "PATCH",
        body: { new_owner_user_id: USER_ID },
        origin,
      });
      expect(res.status).toBe(500);
    });
  });

  describe("GET /api/services/:id/users", () => {
    it("200: 認可済みユーザー一覧を返す", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(listUsersAuthorizedForService).mockResolvedValue([mockUser]);
      vi.mocked(countUsersAuthorizedForService).mockResolvedValue(1);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/users`);
      expect(res.status).toBe(200);
      const json = await res.json<{
        data: Record<string, unknown> & Record<string, unknown>[];
        total?: number;
      }>();
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe(USER_ID);
      expect(json.data[0].email).toBe("user@example.com");
      expect(json.data[0]).not.toHaveProperty("google_sub");
      expect(json.data[0]).not.toHaveProperty("phone");
      expect(json.data[0]).not.toHaveProperty("address");
      expect(json.total).toBe(1);
    });

    it("404: サービスが見つからない", async () => {
      vi.mocked(findServiceById).mockResolvedValue(null);
      vi.mocked(listUsersAuthorizedForService).mockResolvedValue([]);
      vi.mocked(countUsersAuthorizedForService).mockResolvedValue(0);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/users`);
      expect(res.status).toBe(404);
    });

    it("401: 認証なし", async () => {
      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/users`, {
        withAuth: false,
      });
      expect(res.status).toBe(401);
    });

    it("500: DBエラー", async () => {
      vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/users`);
      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /api/services/:id/users/:userId", () => {
    const origin = "https://admin.0g0.xyz";

    it("204: ユーザーアクセスを失効", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(revokeUserServiceTokens).mockResolvedValue(2);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/users/${USER_ID}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(204);
      expect(vi.mocked(revokeUserServiceTokens)).toHaveBeenCalledWith(
        mockEnv.DB,
        USER_ID,
        SERVICE_ID,
        "admin_action",
      );
    });

    it("400: 不正なuserId形式", async () => {
      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/users/invalid-uuid`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(400);
    });

    it("404: サービスが見つからない", async () => {
      vi.mocked(findServiceById).mockResolvedValue(null);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/users/${USER_ID}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(404);
    });

    it("404: ユーザーが見つからない", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      const unknownUserId = "c0000000-0000-0000-0000-000000000099";

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/users/${unknownUserId}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(404);
    });

    it("404: アクティブな認可がない（revokedCount=0）", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(revokeUserServiceTokens).mockResolvedValue(0);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/users/${USER_ID}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(404);
    });

    it("403: CSRFエラー", async () => {
      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/users/${USER_ID}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });

    it("500: DBエラー", async () => {
      vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/users/${USER_ID}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(500);
    });
  });
});
