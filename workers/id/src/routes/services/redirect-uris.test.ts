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
    listRedirectUris: vi.fn(),
    addRedirectUri: vi.fn(),
    findRedirectUriById: vi.fn(),
    deleteRedirectUri: vi.fn(),
    normalizeRedirectUri: vi.fn(),
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
  findServiceById,
  listRedirectUris,
  addRedirectUri,
  findRedirectUriById,
  deleteRedirectUri,
  normalizeRedirectUri,
  verifyAccessToken,
  isAccessTokenRevoked,
  findUserById,
} from "@0g0-id/shared";
import servicesApp from "./index";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

const baseUrl = "https://id.0g0.xyz";
const mockEnv = createMockIdpEnv();

const SERVICE_ID = "a0000000-0000-0000-0000-000000000001";
const URI_ID = "c0000000-0000-0000-0000-000000000001";

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

const mockRedirectUri = {
  id: URI_ID,
  service_id: SERVICE_ID,
  uri: "https://example.com/callback",
  created_at: "2024-01-01T00:00:00Z",
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

describe("Services Redirect URIs API", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(isAccessTokenRevoked).mockResolvedValue(false);
    vi.mocked(findUserById).mockResolvedValue(mockAdminDbUser);
  });

  describe("GET /api/services/:id/redirect-uris", () => {
    it("200: リダイレクトURI一覧を返す", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(listRedirectUris).mockResolvedValue([mockRedirectUri]);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris`);
      expect(res.status).toBe(200);
      const json = await res.json<{
        data: Record<string, unknown> & Record<string, unknown>[];
        total?: number;
      }>();
      expect(json.data).toHaveLength(1);
      expect(json.data[0].uri).toBe("https://example.com/callback");
    });

    it("404: サービスが見つからない", async () => {
      vi.mocked(findServiceById).mockResolvedValue(null);
      vi.mocked(listRedirectUris).mockResolvedValue([]);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris`);
      expect(res.status).toBe(404);
    });

    it("401: 認証なし", async () => {
      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris`, {
        withAuth: false,
      });
      expect(res.status).toBe(401);
    });

    it("500: DBエラー", async () => {
      vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris`);
      expect(res.status).toBe(500);
    });
  });

  describe("POST /api/services/:id/redirect-uris", () => {
    const origin = "https://admin.0g0.xyz";

    it("201: リダイレクトURIを追加", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(normalizeRedirectUri).mockReturnValue("https://example.com/callback");
      vi.mocked(addRedirectUri).mockResolvedValue(mockRedirectUri);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris`, {
        method: "POST",
        body: { uri: "https://example.com/callback" },
        origin,
      });
      expect(res.status).toBe(201);
      const json = await res.json<{
        data: Record<string, unknown> & Record<string, unknown>[];
        total?: number;
      }>();
      expect(json.data.uri).toBe("https://example.com/callback");
    });

    it("404: サービスが見つからない", async () => {
      vi.mocked(findServiceById).mockResolvedValue(null);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris`, {
        method: "POST",
        body: { uri: "https://example.com/callback" },
        origin,
      });
      expect(res.status).toBe(404);
    });

    it("400: normalizeRedirectUriがnullを返す（無効なURI）", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(normalizeRedirectUri).mockReturnValue(null);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris`, {
        method: "POST",
        body: { uri: "https://example.com/callback" },
        origin,
      });
      expect(res.status).toBe(400);
    });

    it("400: uri未指定", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris`, {
        method: "POST",
        body: {},
        origin,
      });
      expect(res.status).toBe(400);
    });

    it("409: 重複URI（UNIQUE制約違反）", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(normalizeRedirectUri).mockReturnValue("https://example.com/callback");
      vi.mocked(addRedirectUri).mockRejectedValue(new Error("UNIQUE constraint failed"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris`, {
        method: "POST",
        body: { uri: "https://example.com/callback" },
        origin,
      });
      expect(res.status).toBe(409);
    });

    it("403: CSRFエラー", async () => {
      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris`, {
        method: "POST",
        body: { uri: "https://example.com/callback" },
      });
      expect(res.status).toBe(403);
    });

    it("500: findServiceByIdのDBエラー", async () => {
      vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris`, {
        method: "POST",
        body: { uri: "https://example.com/callback" },
        origin,
      });
      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /api/services/:id/redirect-uris/:uriId", () => {
    const origin = "https://admin.0g0.xyz";

    it("204: リダイレクトURIを削除", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(findRedirectUriById).mockResolvedValue(mockRedirectUri);
      vi.mocked(deleteRedirectUri).mockResolvedValue(1);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris/${URI_ID}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(204);
    });

    it("400: 不正なuriId形式", async () => {
      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris/invalid-uuid`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(400);
    });

    it("404: サービスが見つからない", async () => {
      vi.mocked(findServiceById).mockResolvedValue(null);
      vi.mocked(findRedirectUriById).mockResolvedValue(mockRedirectUri);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris/${URI_ID}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(404);
    });

    it("404: リダイレクトURIが見つからない", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(findRedirectUriById).mockResolvedValue(null);

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris/${URI_ID}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(404);
    });

    it("403: CSRFエラー", async () => {
      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris/${URI_ID}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });

    it("500: fetch時のDBエラー", async () => {
      vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris/${URI_ID}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(500);
    });

    it("500: delete時のDBエラー", async () => {
      vi.mocked(findServiceById).mockResolvedValue(mockService);
      vi.mocked(findRedirectUriById).mockResolvedValue(mockRedirectUri);
      vi.mocked(deleteRedirectUri).mockRejectedValue(new Error("DB error"));

      const res = await sendRequest(app, `/api/services/${SERVICE_ID}/redirect-uris/${URI_ID}`, {
        method: "DELETE",
        origin,
      });
      expect(res.status).toBe(500);
    });
  });
});
