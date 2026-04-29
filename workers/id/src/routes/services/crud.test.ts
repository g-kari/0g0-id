import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    listServices: vi.fn(),
    countServices: vi.fn(),
    findServiceById: vi.fn(),
    createService: vi.fn(),
    updateServiceFields: vi.fn(),
    deleteService: vi.fn(),
    generateClientId: vi.fn(),
    generateClientSecret: vi.fn(),
    sha256: vi.fn(),
    revokeAllServiceTokens: vi.fn(),
    verifyAccessToken: vi.fn(),
    isAccessTokenRevoked: vi.fn().mockResolvedValue(false),
    findUserById: vi.fn(),
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
  listServices,
  countServices,
  findServiceById,
  createService,
  updateServiceFields,
  deleteService,
  generateClientId,
  generateClientSecret,
  sha256,
  revokeAllServiceTokens,
  verifyAccessToken,
  isAccessTokenRevoked,
  findUserById,
} from "@0g0-id/shared";
import servicesApp from "./index";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

const baseUrl = "https://id.0g0.xyz";
const mockEnv = createMockIdpEnv();

const SERVICE_ID = "a0000000-0000-0000-0000-000000000001";

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

describe("Services CRUD API", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(isAccessTokenRevoked).mockResolvedValue(false);
    vi.mocked(findUserById).mockResolvedValue(mockAdminDbUser);
    vi.mocked(generateClientId).mockReturnValue("cid_new");
    vi.mocked(generateClientSecret).mockReturnValue("secret_new");
    vi.mocked(sha256).mockResolvedValue("hash_new");
  });

  describe("GET /api/services", () => {
    it("200: サービス一覧を返す", async () => {
      vi.mocked(listServices).mockResolvedValue([mockService]);
      vi.mocked(countServices).mockResolvedValue(1);

      const res = await sendRequest(app, "/api/services");
      expect(res.status).toBe(200);
      const json = await res.json<{
        data: Record<string, unknown> & Record<string, unknown>[];
        total?: number;
      }>();
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe(SERVICE_ID);
      expect(json.data[0]).not.toHaveProperty("client_secret_hash");
      expect(json.total).toBe(1);
    });

    it("200: nameフィルターを渡す", async () => {
      vi.mocked(listServices).mockResolvedValue([]);
      vi.mocked(countServices).mockResolvedValue(0);

      await sendRequest(app, "/api/services?name=test");
      expect(vi.mocked(listServices)).toHaveBeenCalledWith(
        mockEnv.DB,
        expect.objectContaining({ name: "test" }),
      );
    });

    it("401: 認証なし", async () => {
      const res = await sendRequest(app, "/api/services", { withAuth: false });
      expect(res.status).toBe(401);
    });

    it("500: DBエラー", async () => {
      vi.mocked(listServices).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, "/api/services");
      expect(res.status).toBe(500);
    });
  });

  describe("GET /api/services/:id", () => {
    it("200: サービス詳細を返す（client_secret_hashなし）", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`);
      expect(res.status).toBe(200);
      const json = await res.json<{
        data: Record<string, unknown> & Record<string, unknown>[];
        total?: number;
      }>();
      expect(json.data.id).toBe(SERVICE_ID);
      expect(json.data).not.toHaveProperty("client_secret_hash");
      expect(json.data).toHaveProperty("updated_at");
    });

    it("404: サービスが見つからない", async () => {
      vi.mocked(findServiceById).mockResolvedValue(null);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`);
      expect(res.status).toBe(404);
    });

    it("400: 不正なUUID形式", async () => {
      const res = await sendRequest(app, "/api/services/invalid-id");
      expect(res.status).toBe(400);
    });

    it("500: DBエラー", async () => {
      vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`);
      expect(res.status).toBe(500);
    });
  });

  describe("POST /api/services", () => {
    const origin = "https://admin.0g0.xyz";

    it("201: サービスを作成しclient_secretを返す", async () => {
      vi.mocked(createService).mockResolvedValue({
        ...mockService,
        id: "new-svc-id",
        client_id: "cid_new",
      });

      const res = await sendRequest(app, "/api/services", {
        method: "POST",
        body: { name: "New Service" },
        origin,
      });
      expect(res.status).toBe(201);
      const json = await res.json<{
        data: Record<string, unknown> & Record<string, unknown>[];
        total?: number;
      }>();
      expect(json.data.client_secret).toBe("secret_new");
      expect(json.data.client_id).toBe("cid_new");
    });

    it("201: allowed_scopesを指定して作成", async () => {
      vi.mocked(createService).mockResolvedValue(mockService);

      const res = await sendRequest(app, "/api/services", {
        method: "POST",
        body: { name: "Scoped", allowed_scopes: ["profile"] },
        origin,
      });
      expect(res.status).toBe(201);
    });

    it("403: CSRFエラー（Originなし）", async () => {
      const res = await sendRequest(app, "/api/services", {
        method: "POST",
        body: { name: "New" },
      });
      expect(res.status).toBe(403);
    });

    it("400: バリデーションエラー（name未指定）", async () => {
      const res = await sendRequest(app, "/api/services", {
        method: "POST",
        body: {},
        origin,
      });
      expect(res.status).toBe(400);
    });

    it("500: DBエラー", async () => {
      vi.mocked(createService).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, "/api/services", {
        method: "POST",
        body: { name: "New" },
        origin,
      });
      expect(res.status).toBe(500);
    });
  });

  describe("PATCH /api/services/:id", () => {
    const origin = "https://admin.0g0.xyz";

    it("200: nameを更新", async () => {
      vi.mocked(updateServiceFields).mockResolvedValue({
        ...mockService,
        name: "Updated",
      });

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`, {
        method: "PATCH",
        body: { name: "Updated" },
        origin,
      });
      expect(res.status).toBe(200);
      const json = await res.json<{
        data: Record<string, unknown> & Record<string, unknown>[];
        total?: number;
      }>();
      expect(json.data.name).toBe("Updated");
    });

    it("200: allowed_scopesを更新", async () => {
      vi.mocked(updateServiceFields).mockResolvedValue({
        ...mockService,
        allowed_scopes: '["profile"]',
      });

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`, {
        method: "PATCH",
        body: { allowed_scopes: ["profile"] },
        origin,
      });
      expect(res.status).toBe(200);
    });

    it("400: name・allowed_scopesどちらも未指定", async () => {
      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`, {
        method: "PATCH",
        body: {},
        origin,
      });
      expect(res.status).toBe(400);
    });

    it("404: サービスが見つからない", async () => {
      vi.mocked(updateServiceFields).mockResolvedValue(null);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`, {
        method: "PATCH",
        body: { name: "Updated" },
        origin,
      });
      expect(res.status).toBe(404);
    });

    it("403: CSRFエラー", async () => {
      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`, {
        method: "PATCH",
        body: { name: "Updated" },
      });
      expect(res.status).toBe(403);
    });

    it("500: DBエラー", async () => {
      vi.mocked(updateServiceFields).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`, {
        method: "PATCH",
        body: { name: "Updated" },
        origin,
      });
      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /api/services/:id", () => {
    const origin = "https://admin.0g0.xyz";

    it("204: サービスを削除（トークン失効後）", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(revokeAllServiceTokens).mockResolvedValue(3);
      vi.mocked(deleteService).mockResolvedValue(undefined);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(204);
      expect(vi.mocked(revokeAllServiceTokens)).toHaveBeenCalledWith(
        mockEnv.DB,
        SERVICE_ID,
        "service_delete",
      );
      expect(vi.mocked(deleteService)).toHaveBeenCalledWith(mockEnv.DB, SERVICE_ID);
    });

    it("404: サービスが見つからない", async () => {
      vi.mocked(findServiceById).mockResolvedValue(null);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(404);
    });

    it("403: CSRFエラー", async () => {
      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });

    it("500: トークン失効に失敗", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(revokeAllServiceTokens).mockRejectedValue(new Error("revoke error"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(500);
    });

    it("500: 削除に失敗", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(revokeAllServiceTokens).mockResolvedValue(0);
      vi.mocked(deleteService).mockRejectedValue(new Error("delete error"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(500);
    });
  });
});
