import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";

// @0g0-id/sharedの全関数をモック
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const { parseJsonBody } = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    parseJsonBody,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    listServices: vi.fn(),
    findServiceById: vi.fn(),
    findUserById: vi.fn(),
    createService: vi.fn(),
    updateServiceFields: vi.fn(),

    deleteService: vi.fn(),
    listRedirectUris: vi.fn(),
    addRedirectUri: vi.fn(),
    deleteRedirectUri: vi.fn(),
    generateClientId: vi.fn(),
    generateClientSecret: vi.fn(),
    sha256: vi.fn(),
    normalizeRedirectUri: vi.fn(),
    rotateClientSecret: vi.fn(),
    transferServiceOwnership: vi.fn(),
    listUsersAuthorizedForService: vi.fn(),
    countUsersAuthorizedForService: vi.fn(),
    revokeUserServiceTokens: vi.fn(),
    revokeAllServiceTokens: vi.fn(),
    findRedirectUriById: vi.fn(),
    countServices: vi.fn(),
    createAdminAuditLog: vi.fn(),
    UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    uuidParamMiddleware: (await importOriginal<typeof import("@0g0-id/shared")>())
      .uuidParamMiddleware,
    parsePagination: (
      query: { limit?: string; offset?: string },
      options: { defaultLimit: number; maxLimit: number } = { defaultLimit: 20, maxLimit: 100 },
    ) => {
      const limitRaw = query.limit !== undefined ? parseInt(query.limit, 10) : options.defaultLimit;
      const offsetRaw = query.offset !== undefined ? parseInt(query.offset, 10) : 0;
      if (query.limit !== undefined && (isNaN(limitRaw) || limitRaw < 1)) {
        return { error: "limit は1以上の整数で指定してください" };
      }
      if (query.offset !== undefined && (isNaN(offsetRaw) || offsetRaw < 0)) {
        return { error: "offset は0以上の整数で指定してください" };
      }
      return { limit: Math.min(limitRaw, options.maxLimit), offset: offsetRaw };
    },
    verifyAccessToken: vi.fn(),
    isAccessTokenRevoked: vi.fn().mockResolvedValue(false),
  };
});

import {
  listServices,
  findServiceById,
  findUserById,
  createService,
  updateServiceFields,
  deleteService,
  listRedirectUris,
  addRedirectUri,
  deleteRedirectUri,
  generateClientId,
  generateClientSecret,
  sha256,
  normalizeRedirectUri,
  rotateClientSecret,
  transferServiceOwnership,
  listUsersAuthorizedForService,
  countUsersAuthorizedForService,
  revokeUserServiceTokens,
  revokeAllServiceTokens,
  countServices,
  createAdminAuditLog,
  verifyAccessToken,
  findRedirectUriById,
} from "@0g0-id/shared";

import servicesRoutes from "./services";

const baseUrl = "https://id.0g0.xyz";

const mockEnv = {
  DB: {} as D1Database,
  JWT_PUBLIC_KEY: "mock-public-key",
  IDP_ORIGIN: "https://id.0g0.xyz",
  USER_ORIGIN: "https://user.0g0.xyz",
  ADMIN_ORIGIN: "https://admin.0g0.xyz",
};

// 管理者トークンペイロード
const mockAdminPayload = {
  iss: "https://id.0g0.xyz",
  sub: "00000000-0000-0000-0000-000000000001",
  aud: "https://id.0g0.xyz",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  jti: "jti-admin",
  kid: "key-1",
  email: "admin@example.com",
  role: "admin" as const,
};

// 一般ユーザートークンペイロード
const mockUserPayload = {
  ...mockAdminPayload,
  sub: "00000000-0000-0000-0000-000000000002",
  email: "user@example.com",
  role: "user" as const,
};

const mockService = {
  id: "00000000-0000-0000-0000-000000000010",
  name: "Test Service",
  client_id: "client-abc",
  client_secret_hash: "hash-abc",
  allowed_scopes: JSON.stringify(["profile", "email"]),
  owner_user_id: "00000000-0000-0000-0000-000000000001",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const mockRedirectUri = {
  id: "00000000-0000-0000-0000-000000000030",
  service_id: "00000000-0000-0000-0000-000000000010",
  uri: "https://app.example.com/callback",
  created_at: "2024-01-01T00:00:00Z",
};

// adminMiddlewareのBANチェック用モックユーザー
const mockAdminUser = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "admin@example.com",
  role: "admin",
  banned_at: null,
} as any;

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route("/api/services", servicesRoutes);
  return app;
}

// リクエストヘルパー
function makeRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    origin?: string;
    withAuth?: boolean;
  } = {},
) {
  const { method = "GET", body, origin, withAuth = true } = options;
  const headers: Record<string, string> = {};
  if (withAuth) headers["Authorization"] = "Bearer mock-token";
  if (origin) headers["Origin"] = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  return new Request(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function sendRequest(
  app: ReturnType<typeof buildApp>,
  path: string,
  options: Parameters<typeof makeRequest>[1] = {},
) {
  return app.request(
    makeRequest(path, options),
    undefined,
    mockEnv as unknown as Record<string, string>,
  );
}

// ===== GET /api/services（管理者のみ）=====
describe("GET /api/services", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockAdminUser);
    vi.mocked(listServices).mockResolvedValue([mockService]);
    vi.mocked(countServices).mockResolvedValue(1);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/services", { withAuth: false });
    expect(res.status).toBe(401);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/services");
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("サービス一覧を返す", async () => {
    const res = await sendRequest(app, "/api/services");
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: unknown[];
      total: number;
      limit: number;
      offset: number;
    }>();
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("client_secret_hashを含まない", async () => {
    const res = await sendRequest(app, "/api/services");
    const body = await res.json<{ data: Record<string, unknown>[] }>();
    expect(body.data[0]).not.toHaveProperty("client_secret_hash");
  });

  it("サービスが0件の場合は空配列を返す", async () => {
    vi.mocked(listServices).mockResolvedValue([]);
    vi.mocked(countServices).mockResolvedValue(0);
    const res = await sendRequest(app, "/api/services");
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(0);
  });

  it("デフォルトのlimit=50/offset=0を使用する", async () => {
    await sendRequest(app, "/api/services");
    expect(vi.mocked(listServices)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 50, offset: 0 }),
    );
  });

  it("指定したlimitとoffsetをDBに渡す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/services?limit=10&offset=20`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listServices)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 10, offset: 20 }),
    );
  });

  it("limitの上限は100", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/services?limit=999`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listServices)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("nameフィルターをDBに渡す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/services?name=test`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listServices)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "test" }),
    );
    expect(vi.mocked(countServices)).toHaveBeenCalledWith(expect.anything(), { name: "test" });
  });

  it("レスポンスにtotal・limit・offsetが含まれる", async () => {
    vi.mocked(countServices).mockResolvedValue(42);
    const res = await app.request(
      new Request(`${baseUrl}/api/services?limit=10&offset=30`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: unknown[];
      total: number;
      limit: number;
      offset: number;
    }>();
    expect(body.total).toBe(42);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(30);
  });
});

// ===== GET /api/services/:id（管理者のみ）=====
describe("GET /api/services/:id", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockAdminUser);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010");
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("サービスを取得して返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.id).toBe("00000000-0000-0000-0000-000000000010");
    expect(body.data.name).toBe("Test Service");
    expect(body.data.client_id).toBe("client-abc");
    expect(vi.mocked(findServiceById)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000010",
    );
  });

  it("client_secret_hashを含まない", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010");
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data).not.toHaveProperty("client_secret_hash");
  });

  it("サービスが存在しない場合 → 404を返す", async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-ffffffffffff");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

// ===== POST /api/services（管理者のみ）=====
describe("POST /api/services", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockAdminUser);
    vi.mocked(generateClientId).mockReturnValue("generated-client-id");
    vi.mocked(generateClientSecret).mockReturnValue("generated-client-secret");
    vi.mocked(sha256).mockResolvedValue("hashed-secret");
    vi.mocked(createService).mockResolvedValue({
      ...mockService,
      client_id: "generated-client-id",
    });
    vi.mocked(createAdminAuditLog).mockResolvedValue(undefined);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/services", {
      method: "POST",
      body: { name: "New Service" },
    });
    expect(res.status).toBe(403);
  });

  it("Originヘッダーなし → 403を返す", async () => {
    const res = await sendRequest(app, "/api/services", {
      method: "POST",
      body: { name: "New Service" },
    });
    expect(res.status).toBe(403);
  });

  it("サービスを作成して201とclient_secretを返す", async () => {
    const res = await sendRequest(app, "/api/services", {
      method: "POST",
      body: { name: "New Service" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.client_id).toBe("generated-client-id");
    expect(body.data.client_secret).toBe("generated-client-secret");
  });

  it("client_secretは作成時のみレスポンスに含まれる", async () => {
    const res = await sendRequest(app, "/api/services", {
      method: "POST",
      body: { name: "New Service" },
      origin: "https://admin.0g0.xyz",
    });
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data).toHaveProperty("client_secret");
    // client_secret_hashは返さない
    expect(body.data).not.toHaveProperty("client_secret_hash");
  });

  it("nameがない場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/services", {
      method: "POST",
      body: {},
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("nameが空文字の場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/services", {
      method: "POST",
      body: { name: "" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(400);
  });

  it("不正なJSONボディ → 400を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/services`, {
        method: "POST",
        headers: {
          Authorization: "Bearer mock-token",
          "Content-Type": "application/json",
          Origin: "https://admin.0g0.xyz",
        },
        body: "invalid-json",
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(400);
  });

  it("allowed_scopesを指定できる", async () => {
    const res = await sendRequest(app, "/api/services", {
      method: "POST",
      body: { name: "New Service", allowed_scopes: ["profile", "email", "phone"] },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(201);
    expect(vi.mocked(createService)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        allowedScopes: JSON.stringify(["profile", "email", "phone"]),
      }),
    );
  });

  it("allowed_scopesを省略した場合はデフォルト値を使用", async () => {
    const res = await sendRequest(app, "/api/services", {
      method: "POST",
      body: { name: "New Service" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(201);
    expect(vi.mocked(createService)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        allowedScopes: JSON.stringify(["profile", "email"]),
      }),
    );
  });

  it("不正なスコープが含まれる場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/services", {
      method: "POST",
      body: { name: "New Service", allowed_scopes: ["profile", "invalid_scope"] },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("profile");
  });

  it("空のallowed_scopesを指定した場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/services", {
      method: "POST",
      body: { name: "New Service", allowed_scopes: [] },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("allowed_scopes must not be empty");
  });

  it("nameが101文字 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/services", {
      method: "POST",
      body: { name: "a".repeat(101) },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("サービス作成時に監査ログが記録される", async () => {
    await sendRequest(app, "/api/services", {
      method: "POST",
      body: { name: "New Service" },
      origin: "https://admin.0g0.xyz",
    });
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        adminUserId: "00000000-0000-0000-0000-000000000001",
        action: "service.create",
        targetType: "service",
      }),
    );
  });

  it("監査ログ記録が失敗しても201を返す", async () => {
    vi.mocked(createAdminAuditLog).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(app, "/api/services", {
      method: "POST",
      body: { name: "New Service" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(201);
  });
});

// ===== PATCH /api/services/:id（管理者のみ）=====
describe("PATCH /api/services/:id", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockAdminUser);
    vi.mocked(updateServiceFields).mockResolvedValue({
      ...mockService,
      allowed_scopes: JSON.stringify(["profile", "email", "phone"]),
    });
    vi.mocked(createAdminAuditLog).mockResolvedValue(undefined);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "PATCH",
      body: { allowed_scopes: ["profile"] },
    });
    expect(res.status).toBe(403);
  });

  it("allowed_scopesを更新して返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "PATCH",
      body: { allowed_scopes: ["profile", "email", "phone"] },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.allowed_scopes).toBe(JSON.stringify(["profile", "email", "phone"]));
  });

  it("allowed_scopesが配列でない場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "PATCH",
      body: { allowed_scopes: "profile" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("不正なスコープが含まれる場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "PATCH",
      body: { allowed_scopes: ["profile", "invalid_scope"] },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("profile");
  });

  it("空配列の場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "PATCH",
      body: { allowed_scopes: [] },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(400);
  });

  it("サービスが存在しない場合 → 404を返す", async () => {
    vi.mocked(updateServiceFields).mockResolvedValue(null);
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-ffffffffffff", {
      method: "PATCH",
      body: { allowed_scopes: ["profile"] },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("nameのみ更新する", async () => {
    vi.mocked(updateServiceFields).mockResolvedValue({
      ...mockService,
      name: "新しいサービス名",
    });
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "PATCH",
      body: { name: "新しいサービス名" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.name).toBe("新しいサービス名");
    expect(vi.mocked(updateServiceFields)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000010",
      {
        name: "新しいサービス名",
      },
    );
  });

  it("nameとallowed_scopesを同時に更新する", async () => {
    vi.mocked(updateServiceFields).mockResolvedValue({
      ...mockService,
      name: "新しいサービス名",
      allowed_scopes: JSON.stringify(["profile"]),
    });
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "PATCH",
      body: { name: "新しいサービス名", allowed_scopes: ["profile"] },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(updateServiceFields)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000010",
      {
        name: "新しいサービス名",
        allowedScopes: JSON.stringify(["profile"]),
      },
    );
  });

  it("nameもallowed_scopesも省略した場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "PATCH",
      body: {},
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("nameが空文字の場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "PATCH",
      body: { name: "" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("nameが存在しないサービスの場合 → 404を返す", async () => {
    vi.mocked(updateServiceFields).mockResolvedValue(null);
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-ffffffffffff", {
      method: "PATCH",
      body: { name: "新しい名前" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("サービス更新時に監査ログが記録される", async () => {
    await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "PATCH",
      body: { name: "新しい名前" },
      origin: "https://admin.0g0.xyz",
    });
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        adminUserId: "00000000-0000-0000-0000-000000000001",
        action: "service.update",
        targetType: "service",
        targetId: "00000000-0000-0000-0000-000000000010",
      }),
    );
  });

  it("監査ログ記録が失敗しても200を返す", async () => {
    vi.mocked(createAdminAuditLog).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "PATCH",
      body: { name: "新しい名前" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(200);
  });
});

// ===== DELETE /api/services/:id（管理者のみ）=====
describe("DELETE /api/services/:id", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockAdminUser);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(deleteService).mockResolvedValue();
    vi.mocked(revokeAllServiceTokens).mockResolvedValue(3);
    vi.mocked(createAdminAuditLog).mockResolvedValue(undefined);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("サービスを削除して204を返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(204);
    expect(vi.mocked(deleteService)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000010",
    );
  });

  it("削除前に全アクティブトークンを失効させる", async () => {
    await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(vi.mocked(revokeAllServiceTokens)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000010",
      "service_delete",
    );
  });

  it("サービスが存在しない場合 → 404を返す", async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-ffffffffffff", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("revokeAllServiceTokens が失敗した場合 → 500を返す", async () => {
    vi.mocked(revokeAllServiceTokens).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    // トークン失効エラー時はサービスを削除しない
    expect(vi.mocked(deleteService)).not.toHaveBeenCalled();
  });

  it("サービス削除時に監査ログが記録される（revoked_token_count含む）", async () => {
    await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        adminUserId: "00000000-0000-0000-0000-000000000001",
        action: "service.delete",
        targetType: "service",
        targetId: "00000000-0000-0000-0000-000000000010",
        details: { name: "Test Service", revoked_token_count: 3 },
      }),
    );
  });
});

// ===== GET /api/services/:id/redirect-uris（管理者のみ）=====
describe("GET /api/services/:id/redirect-uris", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockAdminUser);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(listRedirectUris).mockResolvedValue([mockRedirectUri]);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris",
    );
    expect(res.status).toBe(403);
  });

  it("リダイレクトURI一覧を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris",
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ uri: "https://app.example.com/callback" });
  });

  it("サービスが存在しない場合 → 404を返す", async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-ffffffffffff/redirect-uris",
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

// ===== POST /api/services/:id/redirect-uris（管理者のみ）=====
describe("POST /api/services/:id/redirect-uris", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockAdminUser);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(normalizeRedirectUri).mockReturnValue("https://app.example.com/callback");
    vi.mocked(addRedirectUri).mockResolvedValue(mockRedirectUri);
    vi.mocked(createAdminAuditLog).mockResolvedValue(undefined);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris",
      {
        method: "POST",
        body: { uri: "https://app.example.com/callback" },
      },
    );
    expect(res.status).toBe(403);
  });

  it("リダイレクトURIを追加して201を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris",
      {
        method: "POST",
        body: { uri: "https://app.example.com/callback" },
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.uri).toBe("https://app.example.com/callback");
  });

  it("サービスが存在しない場合 → 404を返す", async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-ffffffffffff/redirect-uris",
      {
        method: "POST",
        body: { uri: "https://app.example.com/callback" },
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(404);
  });

  it("uriがない場合 → 400を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris",
      {
        method: "POST",
        body: {},
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("不正なURIの場合 → 400を返す", async () => {
    vi.mocked(normalizeRedirectUri).mockReturnValue(null);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris",
      {
        method: "POST",
        body: { uri: "not-a-valid-uri" },
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("重複するURIの場合 → 409を返す", async () => {
    vi.mocked(addRedirectUri).mockRejectedValue(new Error("UNIQUE constraint failed"));
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris",
      {
        method: "POST",
        body: { uri: "https://app.example.com/callback" },
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("CONFLICT");
  });

  it("リダイレクトURI追加時に監査ログが記録される", async () => {
    await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris", {
      method: "POST",
      body: { uri: "https://app.example.com/callback" },
      origin: "https://admin.0g0.xyz",
    });
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        adminUserId: "00000000-0000-0000-0000-000000000001",
        action: "service.redirect_uri_added",
        targetType: "service",
        targetId: "00000000-0000-0000-0000-000000000010",
        details: { uri: "https://app.example.com/callback" },
      }),
    );
  });

  it("URI追加が重複エラーの場合は監査ログが記録されない", async () => {
    vi.mocked(addRedirectUri).mockRejectedValue(new Error("UNIQUE constraint failed"));
    await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris", {
      method: "POST",
      body: { uri: "https://app.example.com/callback" },
      origin: "https://admin.0g0.xyz",
    });
    expect(vi.mocked(createAdminAuditLog)).not.toHaveBeenCalled();
  });

  it("http:// URI（非localhost）は登録を拒否して400を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris",
      {
        method: "POST",
        body: { uri: "http://app.example.com/callback" },
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("https:// URI（非localhost）は登録を許可する", async () => {
    vi.mocked(normalizeRedirectUri).mockReturnValue("https://app.example.com/callback");
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris",
      {
        method: "POST",
        body: { uri: "https://app.example.com/callback" },
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(201);
  });

  it("http://localhost の URI は開発用として登録を許可する", async () => {
    vi.mocked(normalizeRedirectUri).mockReturnValue("http://localhost:3000/callback");
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris",
      {
        method: "POST",
        body: { uri: "http://localhost:3000/callback" },
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(201);
  });

  it("http://127.0.0.1 の URI は開発用として登録を許可する", async () => {
    vi.mocked(normalizeRedirectUri).mockReturnValue("http://127.0.0.1:8080/callback");
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris",
      {
        method: "POST",
        body: { uri: "http://127.0.0.1:8080/callback" },
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(201);
  });
});

// ===== POST /api/services/:id/rotate-secret（管理者のみ）=====
describe("POST /api/services/:id/rotate-secret", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockAdminUser);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(generateClientSecret).mockReturnValue("new-client-secret");
    vi.mocked(sha256).mockResolvedValue("new-secret-hash");
    vi.mocked(rotateClientSecret).mockResolvedValue({
      ...mockService,
      client_secret_hash: "new-secret-hash",
      updated_at: "2024-06-01T00:00:00Z",
    });
    vi.mocked(createAdminAuditLog).mockResolvedValue(undefined);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/rotate-secret",
      {
        method: "POST",
        withAuth: false,
      },
    );
    expect(res.status).toBe(401);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/rotate-secret",
      {
        method: "POST",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(403);
  });

  it("Originヘッダーなし（CSRF）→ 403を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/rotate-secret",
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(403);
  });

  it("新しいclient_secretを発行して返す", async () => {
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/rotate-secret",
      {
        method: "POST",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.id).toBe("00000000-0000-0000-0000-000000000010");
    expect(body.data.client_id).toBe("client-abc");
    expect(body.data.client_secret).toBe("new-client-secret");
    expect(body.data).not.toHaveProperty("client_secret_hash");
  });

  it("rotateClientSecretが新しいハッシュで呼ばれる", async () => {
    await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/rotate-secret", {
      method: "POST",
      origin: "https://admin.0g0.xyz",
    });
    expect(vi.mocked(rotateClientSecret)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000010",
      "new-secret-hash",
    );
  });

  it("サービスが存在しない場合（findServiceById）→ 404を返す", async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-ffffffffffff/rotate-secret",
      {
        method: "POST",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("シークレットローテーション時に監査ログが記録される", async () => {
    await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/rotate-secret", {
      method: "POST",
      origin: "https://admin.0g0.xyz",
    });
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        adminUserId: "00000000-0000-0000-0000-000000000001",
        action: "service.secret_rotated",
        targetType: "service",
        targetId: "00000000-0000-0000-0000-000000000010",
      }),
    );
  });

  it("監査ログ記録が失敗しても200を返す", async () => {
    vi.mocked(createAdminAuditLog).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/rotate-secret",
      {
        method: "POST",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(200);
  });
});

// ===== PATCH /api/services/:id/owner（管理者のみ）=====
describe("PATCH /api/services/:id/owner", () => {
  const app = buildApp();

  const mockNewOwner = {
    id: "00000000-0000-0000-0000-000000000003",
    email: "newowner@example.com",
    name: "New Owner",
    picture: null,
    phone: null,
    address: null,
    role: "user" as const,
    google_sub: null,
    line_sub: null,
    twitch_sub: null,
    github_sub: null,
    x_sub: null,
    email_verified: 1,
    banned_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(findUserById).mockResolvedValue(mockNewOwner);
    vi.mocked(transferServiceOwnership).mockResolvedValue({
      ...mockService,
      owner_user_id: "00000000-0000-0000-0000-000000000003",
      updated_at: "2024-06-01T00:00:00Z",
    });
    vi.mocked(createAdminAuditLog).mockResolvedValue(undefined);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/owner", {
      method: "PATCH",
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/owner", {
      method: "PATCH",
      body: { new_owner_user_id: "00000000-0000-0000-0000-000000000003" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(403);
  });

  it("Originヘッダーなし（CSRF）→ 403を返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/owner", {
      method: "PATCH",
      body: { new_owner_user_id: "00000000-0000-0000-0000-000000000003" },
    });
    expect(res.status).toBe(403);
  });

  it("所有権を転送して新しいowner_user_idを返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/owner", {
      method: "PATCH",
      body: { new_owner_user_id: "00000000-0000-0000-0000-000000000003" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.id).toBe("00000000-0000-0000-0000-000000000010");
    expect(body.data.owner_user_id).toBe("00000000-0000-0000-0000-000000000003");
    expect(vi.mocked(transferServiceOwnership)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000010",
      "00000000-0000-0000-0000-000000000003",
    );
  });

  it("client_secret_hashを含まない", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/owner", {
      method: "PATCH",
      body: { new_owner_user_id: "00000000-0000-0000-0000-000000000003" },
      origin: "https://admin.0g0.xyz",
    });
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data).not.toHaveProperty("client_secret_hash");
  });

  it("サービスが存在しない場合 → 404を返す", async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-ffffffffffff/owner", {
      method: "PATCH",
      body: { new_owner_user_id: "00000000-0000-0000-0000-000000000003" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("新しいオーナーが存在しない場合 → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/owner", {
      method: "PATCH",
      body: { new_owner_user_id: "00000000-0000-0000-0000-eeeeeeeeeeee" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("owner");
  });

  it("new_owner_user_idが省略された場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/owner", {
      method: "PATCH",
      body: {},
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("不正なJSONボディ → 400を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/services/00000000-0000-0000-0000-000000000010/owner`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer mock-token",
          "Content-Type": "application/json",
          Origin: "https://admin.0g0.xyz",
        },
        body: "invalid-json",
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(400);
  });

  it("所有権転送時に監査ログが記録される", async () => {
    await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/owner", {
      method: "PATCH",
      body: { new_owner_user_id: "00000000-0000-0000-0000-000000000003" },
      origin: "https://admin.0g0.xyz",
    });
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        adminUserId: "00000000-0000-0000-0000-000000000001",
        action: "service.owner_transferred",
        targetType: "service",
        targetId: "00000000-0000-0000-0000-000000000010",
        details: {
          from: "00000000-0000-0000-0000-000000000001",
          to: "00000000-0000-0000-0000-000000000003",
        },
      }),
    );
  });

  it("監査ログ記録が失敗しても200を返す", async () => {
    vi.mocked(createAdminAuditLog).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/owner", {
      method: "PATCH",
      body: { new_owner_user_id: "00000000-0000-0000-0000-000000000003" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(200);
  });
});

// ===== GET /api/services/:id/users（管理者のみ）=====
describe("GET /api/services/:id/users", () => {
  const app = buildApp();

  const mockAuthorizedUser = {
    id: "00000000-0000-0000-0000-000000000004",
    email: "user@example.com",
    name: "Test User",
    picture: null,
    phone: null,
    address: null,
    role: "user" as const,
    google_sub: null,
    line_sub: null,
    twitch_sub: null,
    github_sub: null,
    x_sub: null,
    email_verified: 1,
    banned_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockAdminUser);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(listUsersAuthorizedForService).mockResolvedValue([mockAuthorizedUser]);
    vi.mocked(countUsersAuthorizedForService).mockResolvedValue(1);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/users", {
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/users");
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("サービスが存在しない場合 → 404を返す", async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-ffffffffffff/users");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("認可済みユーザー一覧とtotalを返す", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/users");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown>[]; total: number }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("00000000-0000-0000-0000-000000000004");
    expect(body.data[0].email).toBe("user@example.com");
    expect(body.total).toBe(1);
  });

  it("センシティブなフィールドを含まない", async () => {
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/users");
    const body = await res.json<{ data: Record<string, unknown>[] }>();
    expect(body.data[0]).not.toHaveProperty("google_sub");
    expect(body.data[0]).not.toHaveProperty("phone");
    expect(body.data[0]).not.toHaveProperty("address");
  });

  it("認可済みユーザーが0件の場合は空配列を返す", async () => {
    vi.mocked(listUsersAuthorizedForService).mockResolvedValue([]);
    vi.mocked(countUsersAuthorizedForService).mockResolvedValue(0);
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/users");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; total: number }>();
    expect(body.data).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("limitとoffsetをDBに渡す", async () => {
    const res = await app.request(
      new Request(
        `${baseUrl}/api/services/00000000-0000-0000-0000-000000000010/users?limit=10&offset=20`,
        {
          headers: { Authorization: "Bearer mock-token" },
        },
      ),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listUsersAuthorizedForService)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000010",
      10,
      20,
    );
  });

  it("limitの上限は100", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/services/00000000-0000-0000-0000-000000000010/users?limit=999`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listUsersAuthorizedForService)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000010",
      100,
      0,
    );
  });
});

// ===== DELETE /api/services/:id/users/:userId（管理者のみ）=====
describe("DELETE /api/services/:id/users/:userId", () => {
  const app = buildApp();

  const mockTargetUser = {
    id: "00000000-0000-0000-0000-000000000005",
    email: "target@example.com",
    name: "Target User",
    picture: null,
    phone: null,
    address: null,
    role: "user" as const,
    google_sub: null,
    line_sub: null,
    twitch_sub: null,
    github_sub: null,
    x_sub: null,
    email_verified: 1,
    banned_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(findUserById).mockResolvedValue(mockTargetUser);
    vi.mocked(revokeUserServiceTokens).mockResolvedValue(2);
    vi.mocked(createAdminAuditLog).mockResolvedValue(undefined);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/users/00000000-0000-0000-0000-000000000005",
      {
        method: "DELETE",
        withAuth: false,
      },
    );
    expect(res.status).toBe(401);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/users/00000000-0000-0000-0000-000000000005",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("Originヘッダーなし（CSRF）→ 403を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/users/00000000-0000-0000-0000-000000000005",
      {
        method: "DELETE",
      },
    );
    expect(res.status).toBe(403);
  });

  it("認可を失効させて204を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/users/00000000-0000-0000-0000-000000000005",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(204);
    expect(vi.mocked(revokeUserServiceTokens)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000005",
      "00000000-0000-0000-0000-000000000010",
      "admin_action",
    );
  });

  it("サービスが存在しない場合 → 404を返す", async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-ffffffffffff/users/00000000-0000-0000-0000-000000000005",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("ユーザーが存在しない場合 → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/users/00000000-0000-0000-0000-eeeeeeeeeeee",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("アクティブな認可がない場合 → 404を返す", async () => {
    vi.mocked(revokeUserServiceTokens).mockResolvedValue(0);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/users/00000000-0000-0000-0000-000000000005",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("ユーザーアクセス失効時に監査ログが記録される", async () => {
    await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/users/00000000-0000-0000-0000-000000000005",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        adminUserId: "00000000-0000-0000-0000-000000000001",
        action: "service.user_access_revoked",
        targetType: "service",
        targetId: "00000000-0000-0000-0000-000000000010",
        details: { user_id: "00000000-0000-0000-0000-000000000005" },
      }),
    );
  });
});

// ===== DELETE /api/services/:id/redirect-uris/:uriId（管理者のみ）=====
describe("DELETE /api/services/:id/redirect-uris/:uriId", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockAdminUser);
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    vi.mocked(findRedirectUriById).mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000030",
      service_id: "00000000-0000-0000-0000-000000000010",
      uri: "https://example.com/callback",
      created_at: "2024-01-01T00:00:00Z",
    });
    vi.mocked(deleteRedirectUri).mockResolvedValue(1);
    vi.mocked(createAdminAuditLog).mockResolvedValue(undefined);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris/00000000-0000-0000-0000-000000000030",
      {
        method: "DELETE",
      },
    );
    expect(res.status).toBe(403);
  });

  it("リダイレクトURIを削除して204を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris/00000000-0000-0000-0000-000000000030",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(204);
    expect(vi.mocked(deleteRedirectUri)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000030",
      "00000000-0000-0000-0000-000000000010",
    );
  });

  it("リダイレクトURIが存在しない場合 → 404を返す", async () => {
    vi.mocked(findRedirectUriById).mockResolvedValue(null);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris/00000000-0000-0000-0000-ffffffffffff",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("サービスが存在しない場合 → 404を返す", async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-ffffffffffff/redirect-uris/00000000-0000-0000-0000-000000000030",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("リダイレクトURI削除時に監査ログが記録される", async () => {
    await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris/00000000-0000-0000-0000-000000000030",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        adminUserId: "00000000-0000-0000-0000-000000000001",
        action: "service.redirect_uri_deleted",
        targetType: "service",
        targetId: "00000000-0000-0000-0000-000000000010",
        details: {
          uri_id: "00000000-0000-0000-0000-000000000030",
          uri: "https://example.com/callback",
        },
      }),
    );
  });
});

// ===== DB例外ハンドリング =====
describe("DB例外ハンドリング", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockAdminUser);
  });

  it("GET / — listServices例外 → 500を返す", async () => {
    vi.mocked(listServices).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(app, "/api/services");
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("GET /:id — findServiceById例外 → 500を返す", async () => {
    vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010");
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("POST / — createService例外 → 500を返す", async () => {
    vi.mocked(generateClientId).mockReturnValue("new-client-id");
    vi.mocked(generateClientSecret).mockReturnValue("new-secret");
    vi.mocked(sha256).mockResolvedValue("hash");
    vi.mocked(createService).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(app, "/api/services", {
      method: "POST",
      body: { name: "New Service" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("PATCH /:id — updateServiceFields例外 → 500を返す", async () => {
    vi.mocked(updateServiceFields).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "PATCH",
      body: { name: "Updated" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("DELETE /:id — findServiceById例外 → 500を返す", async () => {
    vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("GET /:id/redirect-uris — DB例外 → 500を返す", async () => {
    vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris",
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("POST /:id/rotate-secret — findServiceById例外 → 500を返す", async () => {
    vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/rotate-secret",
      {
        method: "POST",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("PATCH /:id/owner — findServiceById例外 → 500を返す", async () => {
    vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/owner", {
      method: "PATCH",
      body: { new_owner_user_id: "00000000-0000-0000-0000-dddddddddddd" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("GET /:id/users — DB例外 → 500を返す", async () => {
    vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(app, "/api/services/00000000-0000-0000-0000-000000000010/users");
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("DELETE /:id/users/:userId — DB例外 → 500を返す", async () => {
    vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/users/00000000-0000-0000-0000-000000000004",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("DELETE /:id/redirect-uris/:uriId — DB例外 → 500を返す", async () => {
    vi.mocked(findServiceById).mockRejectedValue(new Error("DB error"));
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris/00000000-0000-0000-0000-000000000030",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

// ===== パスパラメータバリデーション =====
describe("パスパラメータバリデーション", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockAdminUser);
  });

  it("GET /:id — 不正なサービスID → 400を返す", async () => {
    const res = await sendRequest(app, "/api/services/not-a-uuid");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid service ID format");
  });

  it("GET /:id/redirect-uris — 不正なサービスID → 400を返す", async () => {
    const res = await sendRequest(app, "/api/services/not-a-uuid/redirect-uris");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid service ID format");
  });

  it("DELETE /:id/users/:userId — 有効なサービスIDだが不正なユーザーID → 400を返す", async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/users/invalid-user-id",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid user ID format");
  });

  it("DELETE /:id/redirect-uris/:uriId — 有効なサービスIDだが不正なURI ID → 400を返す", async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService);
    const res = await sendRequest(
      app,
      "/api/services/00000000-0000-0000-0000-000000000010/redirect-uris/invalid-uri-id",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid URI ID format");
  });
});
