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
    findUserById: vi.fn(),
    listUsers: vi.fn(),
    countUsers: vi.fn(),
    updateUserProfile: vi.fn(),
    updateUserRole: vi.fn(),
    updateUserRoleWithRevocation: vi.fn(),
    deleteUser: vi.fn(),
    listUserConnections: vi.fn(),
    revokeUserServiceTokens: vi.fn(),
    revokeUserTokens: vi.fn(),
    deleteMcpSessionsByUser: vi.fn(),
    revokeAllBffSessionsByUserId: vi.fn(),
    revokeBffSessionByIdForUser: vi.fn(),
    findActiveBffSession: vi.fn(),
    revokeTokenByIdForUser: vi.fn(),
    revokeOtherUserTokens: vi.fn(),
    listActiveSessionsByUserId: vi.fn(),
    listActiveBffSessionsByUserId: vi.fn(),
    countServicesByOwner: vi.fn(),
    listServicesByOwner: vi.fn(),
    getUserProviders: vi.fn(),
    unlinkProvider: vi.fn(),
    getLoginEventsByUserId: vi.fn(),
    getUserLoginProviderStats: vi.fn(),
    getUserDailyLoginTrends: vi.fn(),
    banUser: vi.fn(),
    banUserWithRevocation: vi.fn(),
    unbanUser: vi.fn(),
    createAdminAuditLog: vi.fn(),
    UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    uuidParamMiddleware: (await importOriginal<typeof import("@0g0-id/shared")>())
      .uuidParamMiddleware,
    isValidProvider: (value: string) => ["google", "line", "twitch", "github", "x"].includes(value),
    parseDays: (
      daysParam: string | undefined,
      options: { minDays?: number; maxDays?: number } = {},
    ) => {
      if (daysParam === undefined) return undefined;
      const { minDays = 1, maxDays = 90 } = options;
      const days = parseInt(daysParam, 10);
      if (!Number.isInteger(days) || days < minDays || days > maxDays) {
        return {
          error: {
            code: "INVALID_REQUEST",
            message: `days must be an integer between ${minDays} and ${maxDays}`,
          },
        };
      }
      return { days };
    },
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
  findUserById,
  listUsers,
  countUsers,
  updateUserProfile,
  updateUserRoleWithRevocation,
  deleteUser,
  listUserConnections,
  revokeUserServiceTokens,
  revokeUserTokens,
  revokeTokenByIdForUser,
  revokeOtherUserTokens,
  listActiveSessionsByUserId,
  listActiveBffSessionsByUserId,
  revokeBffSessionByIdForUser,
  countServicesByOwner,
  listServicesByOwner,
  getUserProviders,
  unlinkProvider,
  getLoginEventsByUserId,
  getUserLoginProviderStats,
  getUserDailyLoginTrends,
  banUserWithRevocation,
  unbanUser,
  verifyAccessToken,
  type UserFilter,
} from "@0g0-id/shared";
import type { ProviderStatus } from "@0g0-id/shared";

import usersRoutes from "./users";
import { createMockIdpEnv } from "../../../../packages/shared/src/db/test-helpers";

const baseUrl = "https://id.0g0.xyz";

const mockEnv = createMockIdpEnv();

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

const mockUser = {
  id: "00000000-0000-0000-0000-000000000004",
  google_sub: "google-sub-1",
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: "test@example.com",
  email_verified: 1,
  name: "Test User",
  picture: "https://example.com/pic.jpg",
  phone: "090-0000-0000",
  address: "Tokyo",
  role: "user" as const,
  banned_at: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
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
  app.route("/api/users", usersRoutes);
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

// ===== GET /api/users/me =====
describe("GET /api/users/me", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
  });

  it("Authorizationヘッダーなし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me", { withAuth: false });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("認証済みユーザー情報を返す", async () => {
    const res = await sendRequest(app, "/api/users/me");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.id).toBe("00000000-0000-0000-0000-000000000004");
    expect(body.data.email).toBe("test@example.com");
    expect(body.data.name).toBe("Test User");
    expect(body.data.picture).toBe("https://example.com/pic.jpg");
    expect(body.data.role).toBe("user");
  });

  it("ユーザーが存在しない場合 → 401を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, "/api/users/me");
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("verifyAccessTokenが失敗した場合 → 401を返す", async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error("invalid token"));
    const res = await sendRequest(app, "/api/users/me");
    expect(res.status).toBe(401);
  });
});

// ===== GET /api/users/me/data-export =====
describe("GET /api/users/me/data-export", () => {
  const app = buildApp();

  const mockProviders = [
    { provider: "google" as const, connected: true },
    { provider: "line" as const, connected: false },
    { provider: "twitch" as const, connected: false },
    { provider: "github" as const, connected: false },
    { provider: "x" as const, connected: false },
  ];

  const mockConnections = [
    {
      service_id: "svc-1",
      service_name: "My App",
      client_id: "client-1",
      first_authorized_at: "2024-01-01T00:00:00Z",
      last_authorized_at: "2024-01-02T00:00:00Z",
    },
  ];

  const mockLoginHistory = [
    {
      id: "event-1",
      user_id: "00000000-0000-0000-0000-000000000004",
      provider: "google",
      ip_address: "1.2.3.4",
      user_agent: "Mozilla/5.0",
      country: null,
      created_at: "2024-01-01T00:00:00Z",
    },
  ];

  const mockSessions = [
    {
      id: "token-1",
      service_id: null,
      service_name: null,
      created_at: "2024-01-01T00:00:00Z",
      expires_at: "2024-02-01T00:00:00Z",
    },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserProviders).mockResolvedValue(mockProviders);
    vi.mocked(listUserConnections).mockResolvedValue(mockConnections);
    vi.mocked(getLoginEventsByUserId).mockResolvedValue({ events: mockLoginHistory, total: 1 });
    vi.mocked(listActiveSessionsByUserId).mockResolvedValue(mockSessions);
  });

  it("Authorizationヘッダーなし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/data-export", { withAuth: false });
    expect(res.status).toBe(401);
  });

  it("全アカウントデータをまとめてエクスポートする", async () => {
    const res = await sendRequest(app, "/api/users/me/data-export");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.exported_at).toBeDefined();
    expect(body.data.profile).toMatchObject({
      id: "00000000-0000-0000-0000-000000000004",
      email: "test@example.com",
      email_verified: true,
      name: "Test User",
      role: "user",
    });
    expect(body.data.providers).toEqual(mockProviders);
    expect(body.data.service_connections).toEqual(mockConnections);
    expect(body.data.login_history).toEqual(mockLoginHistory);
    expect(body.data.active_sessions).toEqual(mockSessions);
  });

  it("ユーザーが存在しない場合 → 401を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, "/api/users/me/data-export");
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("DB例外時 → 500 INTERNAL_ERROR を返す", async () => {
    vi.mocked(getUserProviders).mockRejectedValue(new Error("D1 error"));
    const res = await sendRequest(app, "/api/users/me/data-export");
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

// ===== GET /api/users/me/security-summary =====
describe("GET /api/users/me/security-summary", () => {
  const app = buildApp();

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
      service_id: null,
      service_name: null,
      created_at: "2024-01-02T00:00:00Z",
      expires_at: "2024-02-02T00:00:00Z",
    },
  ];

  const mockConnections = [
    {
      service_id: "svc-1",
      service_name: "My App",
      client_id: "client-1",
      first_authorized_at: "2024-01-01T00:00:00Z",
      last_authorized_at: "2024-01-02T00:00:00Z",
    },
  ];

  const mockLastLogin = {
    id: "event-1",
    user_id: "00000000-0000-0000-0000-000000000002",
    provider: "google",
    ip_address: "1.2.3.4",
    user_agent: "Mozilla/5.0",
    country: null,
    created_at: "2024-01-15T10:00:00Z",
  };

  const mockProviders: ProviderStatus[] = [
    { provider: "google", connected: true },
    { provider: "line", connected: false },
    { provider: "twitch", connected: false },
    { provider: "github", connected: false },
    { provider: "x", connected: false },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(listActiveSessionsByUserId).mockResolvedValue(mockSessions);
    vi.mocked(listUserConnections).mockResolvedValue(mockConnections);
    vi.mocked(getLoginEventsByUserId).mockResolvedValue({ events: [mockLastLogin], total: 1 });
    vi.mocked(getUserProviders).mockResolvedValue(mockProviders);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
  });

  it("セキュリティ概要を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/security-summary");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.active_sessions_count).toBe(2);
    expect(body.data.connected_services_count).toBe(1);
    expect(body.data.linked_providers).toEqual(["google"]);
    expect(body.data.last_login).toMatchObject({
      provider: "google",
      ip_address: "1.2.3.4",
      created_at: "2024-01-15T10:00:00Z",
    });
    expect(body.data.account_created_at).toBe(mockUser.created_at);
  });

  it("ログイン履歴がない場合はlast_loginがnullを返す", async () => {
    vi.mocked(getLoginEventsByUserId).mockResolvedValue({ events: [], total: 0 });
    const res = await sendRequest(app, "/api/users/me/security-summary");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.last_login).toBeNull();
  });

  it("ユーザーが存在しない場合401を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, "/api/users/me/security-summary");
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("認証なしで401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/security-summary", { withAuth: false });
    expect(res.status).toBe(401);
  });

  it("DB例外時 → 500 INTERNAL_ERROR を返す", async () => {
    vi.mocked(listActiveSessionsByUserId).mockRejectedValue(new Error("D1 error"));
    const res = await sendRequest(app, "/api/users/me/security-summary");
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

// ===== PATCH /api/users/me =====
describe("PATCH /api/users/me", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(updateUserProfile).mockResolvedValue({
      ...mockUser,
      name: "Updated Name",
    });
  });

  it("Originヘッダーなし（CSRF）→ 403を返す", async () => {
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "New Name" },
    });
    expect(res.status).toBe(403);
  });

  it("プロフィールを更新して返す", async () => {
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "Updated Name" },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.name).toBe("Updated Name");
  });

  it("nameが空文字の場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "" },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("全フィールドが未指定の場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: {},
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("nameなしでpictureだけ更新できる", async () => {
    vi.mocked(updateUserProfile).mockResolvedValue({
      ...mockUser,
      picture: "https://cdn.example.com/new-avatar.jpg",
    });
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { picture: "https://cdn.example.com/new-avatar.jpg" },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.picture).toBe("https://cdn.example.com/new-avatar.jpg");
  });

  it("不正なJSONボディ → 400を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/me`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer mock-token",
          Origin: "https://user.0g0.xyz",
          "Content-Type": "application/json",
        },
        body: "invalid-json",
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("pictureをnullに更新できる", async () => {
    vi.mocked(updateUserProfile).mockResolvedValue({ ...mockUser, picture: null });
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "Test User", picture: null },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.picture).toBeNull();
  });

  it("phoneとaddressも更新できる", async () => {
    vi.mocked(updateUserProfile).mockResolvedValue({
      ...mockUser,
      phone: "080-1111-2222",
      address: "Osaka",
    });
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "Test User", phone: "080-1111-2222", address: "Osaka" },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.phone).toBe("080-1111-2222");
    expect(body.data.address).toBe("Osaka");
  });

  it("pictureにHTTP URLを指定 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "Test User", picture: "http://example.com/pic.jpg" },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("pictureにjavascript: URLを指定 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "Test User", picture: "javascript:alert(1)" },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("pictureにdata: URLを指定 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "Test User", picture: "data:image/png;base64,abc" },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("pictureに有効なHTTPS URLを指定 → 成功する", async () => {
    vi.mocked(updateUserProfile).mockResolvedValue({
      ...mockUser,
      picture: "https://cdn.example.com/avatar.jpg",
    });
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "Test User", picture: "https://cdn.example.com/avatar.jpg" },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.picture).toBe("https://cdn.example.com/avatar.jpg");
  });

  it("nameが101文字 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "a".repeat(101) },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("phoneが51文字 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "Test User", phone: "a".repeat(51) },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("addressが501文字 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "Test User", address: "a".repeat(501) },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});

// ===== GET /api/users/me/connections =====
describe("GET /api/users/me/connections", () => {
  const app = buildApp();
  const mockConnections = [
    {
      service_id: "00000000-0000-0000-0000-000000000010",
      service_name: "Test Service",
      client_id: "client-abc",
      first_authorized_at: "2024-01-01T00:00:00Z",
      last_authorized_at: "2024-01-02T00:00:00Z",
    },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(listUserConnections).mockResolvedValue(mockConnections);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/connections", { withAuth: false });
    expect(res.status).toBe(401);
  });

  it("ユーザーの連携サービス一覧を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/connections");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ service_id: "00000000-0000-0000-0000-000000000010" });
  });

  it("連携なしの場合は空配列を返す", async () => {
    vi.mocked(listUserConnections).mockResolvedValue([]);
    const res = await sendRequest(app, "/api/users/me/connections");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(0);
  });
});

// ===== DELETE /api/users/me/connections/:serviceId =====
describe("DELETE /api/users/me/connections/:serviceId", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(revokeUserServiceTokens).mockResolvedValue(1);
  });

  it("Originヘッダーなし（CSRF）→ 403を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/me/connections/00000000-0000-0000-0000-000000000010",
      {
        method: "DELETE",
      },
    );
    expect(res.status).toBe(403);
  });

  it("連携を解除して204を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/me/connections/00000000-0000-0000-0000-000000000010",
      {
        method: "DELETE",
        origin: "https://user.0g0.xyz",
      },
    );
    expect(res.status).toBe(204);
  });

  it("連携が存在しない場合 → 404を返す", async () => {
    vi.mocked(revokeUserServiceTokens).mockResolvedValue(0);
    const res = await sendRequest(
      app,
      "/api/users/me/connections/00000000-0000-0000-0000-000000000089",
      {
        method: "DELETE",
        origin: "https://user.0g0.xyz",
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

// ===== GET /api/users/me/providers =====
describe("GET /api/users/me/providers", () => {
  const app = buildApp();
  const mockProviders: ProviderStatus[] = [
    { provider: "google", connected: true },
    { provider: "line", connected: false },
    { provider: "twitch", connected: false },
    { provider: "github", connected: true },
    { provider: "x", connected: false },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserProviders).mockResolvedValue(mockProviders);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/providers", { withAuth: false });
    expect(res.status).toBe(401);
  });

  it("連携済みプロバイダー一覧を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/providers");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: typeof mockProviders }>();
    expect(body.data).toHaveLength(5);
    expect(body.data.find((p) => p.provider === "google")?.connected).toBe(true);
    expect(body.data.find((p) => p.provider === "line")?.connected).toBe(false);
  });
});

// ===== DELETE /api/users/me/providers/:provider =====
describe("DELETE /api/users/me/providers/:provider", () => {
  const app = buildApp();
  const twoProviders: ProviderStatus[] = [
    { provider: "google", connected: true },
    { provider: "line", connected: false },
    { provider: "twitch", connected: false },
    { provider: "github", connected: true },
    { provider: "x", connected: false },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserProviders).mockResolvedValue(twoProviders);
    vi.mocked(unlinkProvider).mockResolvedValue();
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/providers/github", {
      method: "DELETE",
      origin: "https://id.0g0.xyz",
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });

  it("Originヘッダーなし（CSRF）→ 403を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/providers/github", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("無効なプロバイダー → 400を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/providers/invalid", {
      method: "DELETE",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("最後のプロバイダーの解除 → 409を返す", async () => {
    vi.mocked(getUserProviders).mockResolvedValue([
      { provider: "google" as ProviderStatus["provider"], connected: true },
      { provider: "line" as ProviderStatus["provider"], connected: false },
      { provider: "twitch" as ProviderStatus["provider"], connected: false },
      { provider: "github" as ProviderStatus["provider"], connected: false },
      { provider: "x" as ProviderStatus["provider"], connected: false },
    ]);
    const res = await sendRequest(app, "/api/users/me/providers/google", {
      method: "DELETE",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("LAST_PROVIDER");
  });

  it("未連携のプロバイダーを解除しようとした場合 → 404を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/providers/line", {
      method: "DELETE",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("プロバイダー連携を解除して204を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/providers/github", {
      method: "DELETE",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(204);
    expect(unlinkProvider).toHaveBeenCalledWith(mockEnv.DB, mockUserPayload.sub, "github");
  });
});

// ===== GET /api/users/:id（管理者のみ）=====
describe("GET /api/users/:id", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004", {
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004");
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("ユーザー詳細を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.id).toBe("00000000-0000-0000-0000-000000000004");
    expect(body.data.email).toBe("test@example.com");
    expect(body.data.name).toBe("Test User");
    expect(body.data.phone).toBe("090-0000-0000");
    expect(body.data.address).toBe("Tokyo");
    expect(body.data.role).toBe("user");
    expect(vi.mocked(findUserById)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
    );
  });

  it("内部フィールド（google_sub等）を含まない", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004");
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data).not.toHaveProperty("google_sub");
    expect(body.data).not.toHaveProperty("line_sub");
    expect(body.data).not.toHaveProperty("github_sub");
    expect(body.data).not.toHaveProperty("x_sub");
  });

  it("存在しないユーザーID → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000099");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

// ===== PATCH /api/users/:id/role（管理者のみ）=====
describe("PATCH /api/users/:id/role", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(updateUserRoleWithRevocation).mockResolvedValue({ ...mockUser, role: "admin" });
    vi.mocked(revokeUserTokens).mockResolvedValue();
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/role", {
      method: "PATCH",
      body: { role: "admin" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("Originヘッダーなし（CSRF）→ 403を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/role", {
      method: "PATCH",
      body: { role: "admin" },
    });
    expect(res.status).toBe(403);
  });

  it("ロールを変更して返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/role", {
      method: "PATCH",
      body: { role: "admin" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown> }>();
    expect(body.data.role).toBe("admin");
  });

  it("自分自身のロール変更 → 403を返す", async () => {
    // admin-user-id が自分自身のロールを変更しようとする
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000001/role", {
      method: "PATCH",
      body: { role: "user" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("存在しないユーザーID → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000099/role", {
      method: "PATCH",
      body: { role: "admin" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("不正なrole値 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/role", {
      method: "PATCH",
      body: { role: "superuser" },
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("ロール変更時にbatchで既存トークン失効・MCPセッション削除が同時に実行される", async () => {
    await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/role", {
      method: "PATCH",
      body: { role: "admin" },
      origin: "https://admin.0g0.xyz",
    });
    // updateUserRoleWithRevocation は内部で D1 batch() により
    // users.role 更新 + refresh_tokens 失効 + mcp_sessions 削除 を 1トランザクションで実行する
    expect(vi.mocked(updateUserRoleWithRevocation)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
      "admin",
    );
  });
});

// ===== DELETE /api/users/:id（管理者のみ）=====
describe("DELETE /api/users/:id", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(countServicesByOwner).mockResolvedValue(0);
    vi.mocked(revokeUserTokens).mockResolvedValue();
    vi.mocked(deleteUser).mockResolvedValue(true);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(403);
  });

  it("Originヘッダーなし（CSRF）→ 403を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("ユーザーを削除して204を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(204);
  });

  it("自分自身の削除 → 403を返す", async () => {
    // admin-user-id が自分自身を削除しようとする
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000001", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("存在しないユーザーID → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000099", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("サービスを所有している場合 → 409を返す", async () => {
    vi.mocked(countServicesByOwner).mockResolvedValue(2);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toContain("2");
  });

  it("削除前にトークンを失効させる", async () => {
    await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(vi.mocked(revokeUserTokens)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
      "admin_action",
    );
    expect(vi.mocked(deleteUser)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
    );
  });
});

// ===== GET /api/users（管理者のみ）=====
describe("GET /api/users", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockAdminUser);
    vi.mocked(listUsers).mockResolvedValue([mockUser]);
    vi.mocked(countUsers).mockResolvedValue(1);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/users");
    expect(res.status).toBe(403);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users", { withAuth: false });
    expect(res.status).toBe(401);
  });

  it("ユーザー一覧とtotalを返す", async () => {
    const res = await sendRequest(app, "/api/users");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; total: number }>();
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("limitとoffsetを反映する", async () => {
    vi.mocked(listUsers).mockResolvedValue([]);
    vi.mocked(countUsers).mockResolvedValue(100);

    const res = await app.request(
      new Request(`${baseUrl}/api/users?limit=10&offset=20`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(
      expect.anything(),
      10,
      20,
      expect.any(Object),
    );
  });

  it("limitが100を超える場合は100に制限する", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users?limit=200`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(
      expect.anything(),
      100,
      0,
      expect.any(Object),
    );
  });

  it("レスポンスに内部フィールド（google_sub等）を含まない", async () => {
    const res = await sendRequest(app, "/api/users");
    const body = await res.json<{ data: Record<string, unknown>[] }>();
    expect(body.data[0]).not.toHaveProperty("google_sub");
    expect(body.data[0]).not.toHaveProperty("line_sub");
    expect(body.data[0]).not.toHaveProperty("github_sub");
    expect(body.data[0]).not.toHaveProperty("x_sub");
  });

  it("emailクエリパラメータをフィルターに渡す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users?email=example.com`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(
      expect.anything(),
      50,
      0,
      expect.objectContaining<UserFilter>({ email: "example.com" }),
    );
    expect(vi.mocked(countUsers)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining<UserFilter>({ email: "example.com" }),
    );
  });

  it("roleクエリパラメータをフィルターに渡す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users?role=admin`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(
      expect.anything(),
      50,
      0,
      expect.objectContaining<UserFilter>({ role: "admin" }),
    );
  });

  it("nameクエリパラメータをフィルターに渡す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users?name=Test`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(
      expect.anything(),
      50,
      0,
      expect.objectContaining<UserFilter>({ name: "Test" }),
    );
  });

  it("不正なrole値は無視してフィルターに含めない", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users?role=superuser`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const call = vi.mocked(listUsers).mock.calls[0];
    const filter = call[3] as UserFilter;
    expect(filter.role).toBeUndefined();
  });

  it("複数フィルターを同時に渡せる", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users?email=test&role=user&name=Alice`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(
      expect.anything(),
      50,
      0,
      expect.objectContaining<UserFilter>({ email: "test", role: "user", name: "Alice" }),
    );
  });

  it("banned=true フィルターをfilter.banned=trueとして渡す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users?banned=true`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(
      expect.anything(),
      50,
      0,
      expect.objectContaining<UserFilter>({ banned: true }),
    );
    expect(vi.mocked(countUsers)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining<UserFilter>({ banned: true }),
    );
  });

  it("banned=false フィルターをfilter.banned=falseとして渡す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users?banned=false`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(
      expect.anything(),
      50,
      0,
      expect.objectContaining<UserFilter>({ banned: false }),
    );
    expect(vi.mocked(countUsers)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining<UserFilter>({ banned: false }),
    );
  });

  it("banned=maybe など不正値はfilter.bannedに含めない", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users?banned=maybe`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const call = vi.mocked(listUsers).mock.calls[0];
    const filter = call[3] as UserFilter;
    expect(filter.banned).toBeUndefined();
  });

  it("DB例外時 → 500 INTERNAL_ERROR を返す", async () => {
    vi.mocked(listUsers).mockRejectedValue(new Error("D1 error"));
    const res = await sendRequest(app, "/api/users");
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

// ===== GET /api/users/me/login-history =====
describe("GET /api/users/me/login-history", () => {
  const app = buildApp();

  const mockLoginEvents = [
    {
      id: "event-1",
      user_id: "00000000-0000-0000-0000-000000000002",
      provider: "google",
      ip_address: "127.0.0.1",
      user_agent: "Mozilla/5.0",
      country: null,
      created_at: "2024-01-01T00:00:00Z",
    },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getLoginEventsByUserId).mockResolvedValue({ events: mockLoginEvents, total: 1 });
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/login-history", { withAuth: false });
    expect(res.status).toBe(401);
  });

  it("ログイン履歴とtotalを返す", async () => {
    const res = await sendRequest(app, "/api/users/me/login-history");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; total: number }>();
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("自分のuser_idでgetLoginEventsByUserIdを呼ぶ", async () => {
    await sendRequest(app, "/api/users/me/login-history");
    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000002",
      20,
      0,
      undefined,
    );
  });

  it("limitとoffsetをクエリパラメータから受け取る", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/me/login-history?limit=5&offset=10`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000002",
      5,
      10,
      undefined,
    );
  });

  it("limitの上限は100", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/me/login-history?limit=999`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000002",
      100,
      0,
      undefined,
    );
  });

  it("providerクエリパラメータでフィルタリングできる", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/me/login-history?provider=google`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000002",
      20,
      0,
      "google",
    );
  });

  it("ログイン履歴が0件の場合は空配列を返す", async () => {
    vi.mocked(getLoginEventsByUserId).mockResolvedValue({ events: [], total: 0 });
    const res = await sendRequest(app, "/api/users/me/login-history");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; total: number }>();
    expect(body.data).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});

// ===== GET /api/users/:id/services（管理者のみ）=====
describe("GET /api/users/:id/services", () => {
  const app = buildApp();

  const mockConnections = [
    {
      service_id: "00000000-0000-0000-0000-000000000010",
      service_name: "Test Service",
      client_id: "client-abc",
      first_authorized_at: "2024-01-01T00:00:00Z",
      last_authorized_at: "2024-01-02T00:00:00Z",
    },
    {
      service_id: "00000000-0000-0000-0000-000000000011",
      service_name: "Another Service",
      client_id: "client-xyz",
      first_authorized_at: "2024-02-01T00:00:00Z",
      last_authorized_at: "2024-02-03T00:00:00Z",
    },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(listUserConnections).mockResolvedValue(mockConnections);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/services", {
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/services");
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("対象ユーザーが存在しない場合 → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000098/services");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("認可済みサービス一覧を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/services");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({
      service_id: "00000000-0000-0000-0000-000000000010",
      service_name: "Test Service",
    });
    expect(body.data[1]).toMatchObject({
      service_id: "00000000-0000-0000-0000-000000000011",
      service_name: "Another Service",
    });
  });

  it("認可済みサービスがない場合は空配列を返す", async () => {
    vi.mocked(listUserConnections).mockResolvedValue([]);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/services");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(0);
  });

  it("対象ユーザーのIDでlistUserConnectionsを呼ぶ", async () => {
    await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/services");
    expect(vi.mocked(listUserConnections)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
    );
  });
});

// ===== GET /api/users/:id/login-history（管理者のみ）=====
describe("GET /api/users/:id/login-history", () => {
  const app = buildApp();

  const mockLoginEvents = [
    {
      id: "event-2",
      user_id: "00000000-0000-0000-0000-000000000004",
      provider: "google",
      ip_address: "192.168.0.1",
      user_agent: "Chrome/120",
      country: null,
      created_at: "2024-02-01T00:00:00Z",
    },
    {
      id: "event-1",
      user_id: "00000000-0000-0000-0000-000000000004",
      provider: "github",
      ip_address: "192.168.0.2",
      user_agent: "Firefox/120",
      country: null,
      created_at: "2024-01-01T00:00:00Z",
    },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getLoginEventsByUserId).mockResolvedValue({ events: mockLoginEvents, total: 2 });
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/login-history",
      { withAuth: false },
    );
    expect(res.status).toBe(401);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/login-history",
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("対象ユーザーが存在しない場合 → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000098/login-history",
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("ログイン履歴とtotalを返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/login-history",
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; total: number }>();
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it("対象ユーザーのuser_idでgetLoginEventsByUserIdを呼ぶ", async () => {
    await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/login-history");
    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
      20,
      0,
      undefined,
    );
  });

  it("limitとoffsetをクエリパラメータから受け取る", async () => {
    const res = await app.request(
      new Request(
        `${baseUrl}/api/users/00000000-0000-0000-0000-000000000004/login-history?limit=10&offset=5`,
        {
          headers: { Authorization: "Bearer mock-token" },
        },
      ),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
      10,
      5,
      undefined,
    );
  });

  it("limitの上限は100", async () => {
    const res = await app.request(
      new Request(
        `${baseUrl}/api/users/00000000-0000-0000-0000-000000000004/login-history?limit=500`,
        {
          headers: { Authorization: "Bearer mock-token" },
        },
      ),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
      100,
      0,
      undefined,
    );
  });

  it("providerクエリパラメータでフィルタリングできる", async () => {
    const res = await app.request(
      new Request(
        `${baseUrl}/api/users/00000000-0000-0000-0000-000000000004/login-history?provider=line`,
        {
          headers: { Authorization: "Bearer mock-token" },
        },
      ),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
      20,
      0,
      "line",
    );
  });
});

// ===== GET /api/users/:id/providers（管理者のみ）=====
describe("GET /api/users/:id/providers", () => {
  const app = buildApp();

  const mockProviders: ProviderStatus[] = [
    { provider: "google", connected: true },
    { provider: "line", connected: false },
    { provider: "twitch", connected: false },
    { provider: "github", connected: true },
    { provider: "x", connected: false },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserProviders).mockResolvedValue(mockProviders);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/providers",
      { withAuth: false },
    );
    expect(res.status).toBe(401);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/providers");
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("対象ユーザーが存在しない場合 → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000098/providers");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("プロバイダー連携状態の一覧を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/providers");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: ProviderStatus[] }>();
    expect(body.data).toHaveLength(5);
    expect(body.data.find((p) => p.provider === "google")?.connected).toBe(true);
    expect(body.data.find((p) => p.provider === "github")?.connected).toBe(true);
    expect(body.data.find((p) => p.provider === "line")?.connected).toBe(false);
  });

  it("対象ユーザーのIDでgetUserProvidersを呼ぶ", async () => {
    await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/providers");
    expect(vi.mocked(getUserProviders)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
    );
  });
});

// ===== GET /api/users/:id/owned-services（管理者のみ）=====
describe("GET /api/users/:id/owned-services", () => {
  const app = buildApp();

  const mockOwnedServices = [
    {
      id: "00000000-0000-0000-0000-000000000010",
      name: "My Service",
      client_id: "client-abc",
      client_secret_hash: "hash-1",
      allowed_scopes: '["profile","email"]',
      owner_user_id: "00000000-0000-0000-0000-000000000004",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    },
    {
      id: "00000000-0000-0000-0000-000000000011",
      name: "Another Owned Service",
      client_id: "client-xyz",
      client_secret_hash: "hash-2",
      allowed_scopes: '["profile"]',
      owner_user_id: "00000000-0000-0000-0000-000000000004",
      created_at: "2024-02-01T00:00:00Z",
      updated_at: "2024-02-01T00:00:00Z",
    },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(listServicesByOwner).mockResolvedValue(mockOwnedServices);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/owned-services",
      { withAuth: false },
    );
    expect(res.status).toBe(401);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/owned-services",
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("対象ユーザーが存在しない場合 → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000098/owned-services",
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("所有サービス一覧を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/owned-services",
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({
      id: "00000000-0000-0000-0000-000000000010",
      name: "My Service",
    });
    expect(body.data[1]).toMatchObject({
      id: "00000000-0000-0000-0000-000000000011",
      name: "Another Owned Service",
    });
  });

  it("所有サービスがない場合は空配列を返す", async () => {
    vi.mocked(listServicesByOwner).mockResolvedValue([]);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/owned-services",
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(0);
  });

  it("レスポンスにclient_secret_hashを含まない", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/owned-services",
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, unknown>[] }>();
    expect(body.data[0]).not.toHaveProperty("client_secret_hash");
  });

  it("対象ユーザーのIDでlistServicesByOwnerを呼ぶ", async () => {
    await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/owned-services");
    expect(vi.mocked(listServicesByOwner)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
    );
  });
});

// ===== GET /api/users/me/tokens =====
describe("GET /api/users/me/tokens", () => {
  const app = buildApp();

  const mockSessions = [
    {
      id: "rt-1",
      service_id: null,
      service_name: null,
      created_at: "2024-01-01T00:00:00Z",
      expires_at: "2024-02-01T00:00:00Z",
    },
    {
      id: "rt-2",
      service_id: "svc-1",
      service_name: "My Service",
      created_at: "2024-01-02T00:00:00Z",
      expires_at: "2024-02-02T00:00:00Z",
    },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(listActiveSessionsByUserId).mockResolvedValue(mockSessions);
  });

  it("Authorizationヘッダーなし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/tokens", { withAuth: false });
    expect(res.status).toBe(401);
  });

  it("アクティブセッション一覧を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/tokens");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: typeof mockSessions }>();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe("rt-1");
    expect(body.data[0].service_id).toBeNull();
    expect(body.data[1].service_name).toBe("My Service");
  });

  it("自分のuser_idでlistActiveSessionsByUserIdを呼ぶ", async () => {
    await sendRequest(app, "/api/users/me/tokens");
    expect(vi.mocked(listActiveSessionsByUserId)).toHaveBeenCalledWith(
      mockEnv.DB,
      mockUserPayload.sub,
    );
  });

  it("セッションが0件の場合は空配列を返す", async () => {
    vi.mocked(listActiveSessionsByUserId).mockResolvedValue([]);
    const res = await sendRequest(app, "/api/users/me/tokens");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(0);
  });
});

// ===== GET /api/users/me/bff-sessions =====
describe("GET /api/users/me/bff-sessions", () => {
  const app = buildApp();

  const mockBffSessions = [
    {
      id: "bff-1",
      user_id: mockUserPayload.sub,
      created_at: 1700000000,
      expires_at: 1800000000,
      user_agent: "Mozilla/5.0",
      ip: "192.0.2.1",
      bff_origin: "https://user.0g0.xyz",
      has_device_key: true,
      device_bound_at: 1700000001,
    },
    {
      id: "bff-2",
      user_id: mockUserPayload.sub,
      created_at: 1700000010,
      expires_at: 1800000000,
      user_agent: "Mozilla/5.0",
      ip: "192.0.2.2",
      bff_origin: "https://user.0g0.xyz",
      has_device_key: false,
      device_bound_at: null,
    },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(listActiveBffSessionsByUserId).mockResolvedValue(mockBffSessions);
  });

  it("Authorizationヘッダーなし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/bff-sessions", { withAuth: false });
    expect(res.status).toBe(401);
  });

  it("BFFセッション一覧を返す（DBSC バインド情報を含む）", async () => {
    const res = await sendRequest(app, "/api/users/me/bff-sessions");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: typeof mockBffSessions }>();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].has_device_key).toBe(true);
    expect(body.data[0].device_bound_at).toBe(1700000001);
    expect(body.data[1].has_device_key).toBe(false);
    expect(body.data[1].device_bound_at).toBeNull();
  });

  it("自分のuser_idでlistActiveBffSessionsByUserIdを呼ぶ", async () => {
    await sendRequest(app, "/api/users/me/bff-sessions");
    expect(vi.mocked(listActiveBffSessionsByUserId)).toHaveBeenCalledWith(
      mockEnv.DB,
      mockUserPayload.sub,
    );
  });

  it("セッションが0件の場合は空配列を返す", async () => {
    vi.mocked(listActiveBffSessionsByUserId).mockResolvedValue([]);
    const res = await sendRequest(app, "/api/users/me/bff-sessions");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(0);
  });
});

// ===== DELETE /api/users/me/tokens =====
describe("DELETE /api/users/me/tokens", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(revokeUserTokens).mockResolvedValue(undefined);
  });

  it("Authorizationヘッダーなし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/tokens", {
      method: "DELETE",
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });

  it("Originヘッダーなし（CSRF）→ 403を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/tokens", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("全リフレッシュトークンを無効化して204を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/tokens", {
      method: "DELETE",
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(204);
    expect(vi.mocked(revokeUserTokens)).toHaveBeenCalledWith(
      expect.anything(),
      mockUserPayload.sub,
      "user_logout_all",
    );
  });
});

// ===== DELETE /api/users/me/tokens/:tokenId =====
describe("DELETE /api/users/me/tokens/:tokenId", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(revokeTokenByIdForUser).mockResolvedValue(1);
  });

  it("Authorizationヘッダーなし → 401を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/me/tokens/00000000-0000-0000-0000-000000000020",
      {
        method: "DELETE",
        withAuth: false,
      },
    );
    expect(res.status).toBe(401);
  });

  it("Originヘッダーなし（CSRF）→ 403を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/me/tokens/00000000-0000-0000-0000-000000000020",
      {
        method: "DELETE",
      },
    );
    expect(res.status).toBe(403);
  });

  it("指定セッションを失効させて204を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/me/tokens/00000000-0000-0000-0000-000000000020",
      {
        method: "DELETE",
        origin: "https://user.0g0.xyz",
      },
    );
    expect(res.status).toBe(204);
    expect(vi.mocked(revokeTokenByIdForUser)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000020",
      mockUserPayload.sub,
      "user_logout",
    );
  });

  it("存在しないor他ユーザーのセッションID → 404を返す", async () => {
    vi.mocked(revokeTokenByIdForUser).mockResolvedValue(0);
    const res = await sendRequest(
      app,
      "/api/users/me/tokens/00000000-0000-0000-0000-000000000029",
      {
        method: "DELETE",
        origin: "https://user.0g0.xyz",
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("他ユーザーのトークンIDは失効できない（所有権チェック）", async () => {
    vi.mocked(revokeTokenByIdForUser).mockResolvedValue(0);
    const res = await sendRequest(
      app,
      "/api/users/me/tokens/00000000-0000-0000-0000-000000000028",
      {
        method: "DELETE",
        origin: "https://user.0g0.xyz",
      },
    );
    expect(res.status).toBe(404);
  });
});

// ===== DELETE /api/users/me/tokens/others =====
describe("DELETE /api/users/me/tokens/others", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(revokeOtherUserTokens).mockResolvedValue(2);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/tokens/others", {
      method: "DELETE",
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });

  it("Originなし（CSRF） → 403を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/tokens/others", {
      method: "DELETE",
      body: { token_hash: "abc123hash" },
    });
    expect(res.status).toBe(403);
  });

  it("現在のセッション以外を全て失効させてrevoked_countを返す", async () => {
    const res = await sendRequest(app, "/api/users/me/tokens/others", {
      method: "DELETE",
      body: { token_hash: "abc123hash" },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { revoked_count: number } }>();
    expect(body.data.revoked_count).toBe(2);
    expect(vi.mocked(revokeOtherUserTokens)).toHaveBeenCalledWith(
      mockEnv.DB,
      mockUserPayload.sub,
      "abc123hash",
      "user_logout_others",
    );
  });

  it("token_hashがない場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/tokens/others", {
      method: "DELETE",
      body: {},
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("token_hashが空文字の場合 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/tokens/others", {
      method: "DELETE",
      body: { token_hash: "" },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("該当セッションがない場合はrevoked_count: 0を返す", async () => {
    vi.mocked(revokeOtherUserTokens).mockResolvedValue(0);
    const res = await sendRequest(app, "/api/users/me/tokens/others", {
      method: "DELETE",
      body: { token_hash: "only-session-hash" },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { revoked_count: number } }>();
    expect(body.data.revoked_count).toBe(0);
  });
});

// ===== DELETE /api/users/:id/tokens（管理者のみ）=====
describe("GET /api/users/:id/tokens", () => {
  const app = buildApp();

  const mockSessions = [
    {
      id: "rt-1",
      service_id: null,
      service_name: null,
      created_at: "2024-01-01T00:00:00Z",
      expires_at: "2024-02-01T00:00:00Z",
    },
    {
      id: "rt-2",
      service_id: "svc-1",
      service_name: "My Service",
      created_at: "2024-01-02T00:00:00Z",
      expires_at: "2024-02-02T00:00:00Z",
    },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(listActiveSessionsByUserId).mockResolvedValue(mockSessions);
  });

  it("管理者: 存在するユーザーのアクティブセッション一覧を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/tokens");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: typeof mockSessions }>();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe("rt-1");
    expect(body.data[1].service_name).toBe("My Service");
    expect(vi.mocked(listActiveSessionsByUserId)).toHaveBeenCalledWith(
      mockEnv.DB,
      "00000000-0000-0000-0000-000000000004",
    );
  });

  it("管理者: 存在しないユーザー → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000099/tokens");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("管理者: セッションが0件でも空配列を返す", async () => {
    vi.mocked(listActiveSessionsByUserId).mockResolvedValue([]);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/tokens");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(0);
  });

  it("一般ユーザー → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/tokens");
    expect(res.status).toBe(403);
  });

  it("未認証 → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/tokens", {
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/users/:id/bff-sessions", () => {
  const app = buildApp();

  const mockBffSessions = [
    {
      id: "00000000-0000-0000-0000-0000000000aa",
      user_id: "00000000-0000-0000-0000-000000000004",
      created_at: 1700000000,
      expires_at: 1800000000,
      user_agent: "Mozilla/5.0",
      ip: "203.0.113.1",
      bff_origin: "https://admin.0g0.xyz",
      has_device_key: true,
      device_bound_at: 1700000100,
    },
    {
      id: "00000000-0000-0000-0000-0000000000bb",
      user_id: "00000000-0000-0000-0000-000000000004",
      created_at: 1699000000,
      expires_at: 1799000000,
      user_agent: null,
      ip: null,
      bff_origin: "https://user.0g0.xyz",
      has_device_key: false,
      device_bound_at: null,
    },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(listActiveBffSessionsByUserId).mockResolvedValue(mockBffSessions);
  });

  it("管理者: has_device_key / device_bound_at を含む BFF セッション一覧を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/bff-sessions",
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: typeof mockBffSessions }>();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].has_device_key).toBe(true);
    expect(body.data[0].device_bound_at).toBe(1700000100);
    expect(body.data[1].has_device_key).toBe(false);
    expect(vi.mocked(listActiveBffSessionsByUserId)).toHaveBeenCalledWith(
      mockEnv.DB,
      "00000000-0000-0000-0000-000000000004",
    );
  });

  it("管理者: 存在しないユーザー → 404", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000099/bff-sessions",
    );
    expect(res.status).toBe(404);
  });

  it("一般ユーザー → 403", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/bff-sessions",
    );
    expect(res.status).toBe(403);
  });

  it("未認証 → 401", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/bff-sessions",
      { withAuth: false },
    );
    expect(res.status).toBe(401);
  });
});

// ===== DELETE /api/users/:id/bff-sessions/:sessionId（管理者のみ）=====
describe("DELETE /api/users/:id/bff-sessions/:sessionId", () => {
  const app = buildApp();
  const userId = "00000000-0000-0000-0000-000000000004";
  const sessionId = "00000000-0000-0000-0000-0000000000aa";
  const path = `/api/users/${userId}/bff-sessions/${sessionId}`;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(revokeBffSessionByIdForUser).mockResolvedValue(1);
  });

  it("Authorization ヘッダーなし → 401", async () => {
    const res = await sendRequest(app, path, { method: "DELETE", withAuth: false });
    expect(res.status).toBe(401);
  });

  it("管理者以外 → 403", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, path, {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(403);
  });

  it("Origin ヘッダーなし（CSRF）→ 403", async () => {
    const res = await sendRequest(app, path, { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("非UUID形式の sessionId → 400", async () => {
    const res = await sendRequest(app, `/api/users/${userId}/bff-sessions/not-a-uuid`, {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(revokeBffSessionByIdForUser)).not.toHaveBeenCalled();
  });

  it("対象ユーザー不在 → 404", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(
      app,
      `/api/users/00000000-0000-0000-0000-000000000099/bff-sessions/${sessionId}`,
      { method: "DELETE", origin: "https://admin.0g0.xyz" },
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("指定 BFF セッションを失効させて 204 を返す", async () => {
    const res = await sendRequest(app, path, {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(204);
    expect(vi.mocked(revokeBffSessionByIdForUser)).toHaveBeenCalledWith(
      expect.anything(),
      sessionId,
      userId,
      `admin_action:${mockAdminPayload.sub}`,
    );
  });

  it("存在しないor他ユーザー所属の sessionId → 404", async () => {
    vi.mocked(revokeBffSessionByIdForUser).mockResolvedValue(0);
    const res = await sendRequest(app, path, {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

describe("DELETE /api/users/:id/tokens", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(revokeUserTokens).mockResolvedValue(undefined);
  });

  it("Authorizationヘッダーなし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/tokens", {
      method: "DELETE",
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });

  it("管理者以外 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/tokens", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(403);
  });

  it("Originヘッダーなし（CSRF）→ 403を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/tokens", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("対象ユーザーが存在しない → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000096/tokens", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("対象ユーザーの全リフレッシュトークンを無効化して204を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000004/tokens", {
      method: "DELETE",
      origin: "https://admin.0g0.xyz",
    });
    expect(res.status).toBe(204);
    expect(vi.mocked(revokeUserTokens)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
      "admin_action",
    );
  });
});

// ===== DELETE /api/users/:id/tokens/:tokenId（管理者のみ）=====
describe("DELETE /api/users/:id/tokens/:tokenId", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(revokeTokenByIdForUser).mockResolvedValue(1);
  });

  it("Authorizationヘッダーなし → 401を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/tokens/00000000-0000-0000-0000-000000000020",
      {
        method: "DELETE",
        withAuth: false,
      },
    );
    expect(res.status).toBe(401);
  });

  it("管理者以外 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/tokens/00000000-0000-0000-0000-000000000020",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(403);
  });

  it("Originヘッダーなし（CSRF）→ 403を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/tokens/00000000-0000-0000-0000-000000000020",
      { method: "DELETE" },
    );
    expect(res.status).toBe(403);
  });

  it("対象ユーザーが存在しない → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000096/tokens/00000000-0000-0000-0000-000000000020",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("指定セッションを失効させて204を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/tokens/00000000-0000-0000-0000-000000000020",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(204);
    expect(vi.mocked(revokeTokenByIdForUser)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000020",
      "00000000-0000-0000-0000-000000000004",
      "admin_action",
    );
  });

  it("存在しないor他ユーザー所属のセッションID → 404を返す", async () => {
    vi.mocked(revokeTokenByIdForUser).mockResolvedValue(0);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/tokens/00000000-0000-0000-0000-000000000029",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("ユーザーIDとトークンIDの両方をrevokeTokenByIdForUserに渡す", async () => {
    await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000005/tokens/00000000-0000-0000-0000-000000000021",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(vi.mocked(revokeTokenByIdForUser)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000021",
      "00000000-0000-0000-0000-000000000005",
      "admin_action",
    );
  });
});

// ===== DELETE /api/users/me — 自己アカウント削除 =====
describe("DELETE /api/users/me", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue({ ...mockUser, id: mockUserPayload.sub });
    vi.mocked(countServicesByOwner).mockResolvedValue(0);
    vi.mocked(revokeUserTokens).mockResolvedValue(undefined);
    vi.mocked(deleteUser).mockResolvedValue(true);
  });

  it("Authorizationヘッダーなし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me", {
      method: "DELETE",
      origin: "https://id.0g0.xyz",
      withAuth: false,
    });
    expect(res.status).toBe(401);
  });

  it("Originヘッダーなし（CSRF） → 403を返す", async () => {
    const res = await sendRequest(app, "/api/users/me", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("ユーザーが存在しない → 401を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, "/api/users/me", {
      method: "DELETE",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("サービスを所有している場合 → 409を返す", async () => {
    vi.mocked(countServicesByOwner).mockResolvedValue(2);
    const res = await sendRequest(app, "/api/users/me", {
      method: "DELETE",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toContain("2 service(s)");
  });

  it("トークンを失効してからユーザーを削除し204を返す", async () => {
    const res = await sendRequest(app, "/api/users/me", {
      method: "DELETE",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(204);
    expect(vi.mocked(revokeUserTokens)).toHaveBeenCalledWith(
      expect.anything(),
      mockUserPayload.sub,
      "admin_action",
    );
    expect(vi.mocked(deleteUser)).toHaveBeenCalledWith(expect.anything(), mockUserPayload.sub);
  });

  it("revokeUserTokensがdeleteUserより先に呼ばれる", async () => {
    const callOrder: string[] = [];
    vi.mocked(revokeUserTokens).mockImplementation(async () => {
      callOrder.push("revoke");
    });
    vi.mocked(deleteUser).mockImplementation(async () => {
      callOrder.push("delete");
      return true;
    });

    await sendRequest(app, "/api/users/me", {
      method: "DELETE",
      origin: "https://id.0g0.xyz",
    });

    expect(callOrder).toEqual(["revoke", "delete"]);
  });
});

describe("PATCH /api/users/:id/ban — ユーザー停止", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.resetAllMocks();
    app = buildApp();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue({
      ...mockUser,
      id: "00000000-0000-0000-0000-000000000003",
    });
    vi.mocked(banUserWithRevocation).mockResolvedValue({
      ...mockUser,
      id: "00000000-0000-0000-0000-000000000003",
      banned_at: "2026-03-24T00:00:00Z",
    });
  });

  it("対象ユーザーを停止し200を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000003/ban", {
      method: "PATCH",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { banned_at: string } }>();
    expect(body.data.banned_at).toBe("2026-03-24T00:00:00Z");
    // batch() 内でトークン失効・MCPセッション削除も同時にアトミック実行される
    expect(vi.mocked(banUserWithRevocation)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000003",
    );
  });

  it("banUserWithRevocation() が失敗した場合 → 500とfailure監査ログを返す", async () => {
    vi.mocked(banUserWithRevocation).mockRejectedValue(new Error("D1 batch failed"));
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000003/ban", {
      method: "PATCH",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("自分自身を停止しようとした場合 → 403を返す", async () => {
    const res = await sendRequest(app, `/api/users/${mockAdminPayload.sub}/ban`, {
      method: "PATCH",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("管理者ユーザーを停止しようとした場合 → 403を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue({
      ...mockUser,
      id: "00000000-0000-0000-0000-000000000003",
      role: "admin",
    });
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000003/ban", {
      method: "PATCH",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("すでに停止済みのユーザーを停止しようとした場合 → 409を返す", async () => {
    vi.mocked(findUserById)
      .mockResolvedValueOnce(mockAdminUser)
      .mockResolvedValueOnce({
        ...mockUser,
        id: "00000000-0000-0000-0000-000000000003",
        banned_at: "2026-01-01T00:00:00Z",
      });
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000003/ban", {
      method: "PATCH",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("CONFLICT");
  });

  it("ユーザーが存在しない場合 → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000097/ban", {
      method: "PATCH",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/users/:id/ban — ユーザー停止解除", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.resetAllMocks();
    app = buildApp();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById)
      .mockResolvedValueOnce(mockAdminUser)
      .mockResolvedValue({
        ...mockUser,
        id: "00000000-0000-0000-0000-000000000003",
        banned_at: "2026-01-01T00:00:00Z",
      });
    vi.mocked(unbanUser).mockResolvedValue({
      ...mockUser,
      id: "00000000-0000-0000-0000-000000000003",
      banned_at: null,
    });
  });

  it("停止中ユーザーを解除し200を返す", async () => {
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000003/ban", {
      method: "DELETE",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { banned_at: null } }>();
    expect(body.data.banned_at).toBeNull();
  });

  it("停止されていないユーザーを解除しようとした場合 → 409を返す", async () => {
    vi.mocked(findUserById).mockReset();
    vi.mocked(findUserById)
      .mockResolvedValueOnce(mockAdminUser)
      .mockResolvedValue({
        ...mockUser,
        id: "00000000-0000-0000-0000-000000000003",
        banned_at: null,
      });
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000003/ban", {
      method: "DELETE",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("CONFLICT");
  });

  it("ユーザーが存在しない場合 → 404を返す", async () => {
    vi.mocked(findUserById).mockReset();
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(app, "/api/users/00000000-0000-0000-0000-000000000097/ban", {
      method: "DELETE",
      origin: "https://id.0g0.xyz",
    });
    expect(res.status).toBe(404);
  });
});

// ===== GET /api/users/:id/login-stats（管理者のみ）=====
describe("GET /api/users/:id/login-stats", () => {
  let app: ReturnType<typeof buildApp>;

  const mockStats = [
    { provider: "google", count: 10 },
    { provider: "github", count: 3 },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    app = buildApp();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue({
      ...mockUser,
      id: "00000000-0000-0000-0000-000000000004",
    });
    vi.mocked(getUserLoginProviderStats).mockResolvedValue(mockStats);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/login-stats",
      { withAuth: false },
    );
    expect(res.status).toBe(401);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/login-stats",
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("対象ユーザーが存在しない場合 → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000098/login-stats",
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("プロバイダー別統計とdaysを返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/login-stats",
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; days: number }>();
    expect(body.data).toHaveLength(2);
    expect(body.days).toBe(30);
  });

  it("daysクエリパラメータを受け取る", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/00000000-0000-0000-0000-000000000004/login-stats?days=7`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ days: number }>();
    expect(body.days).toBe(7);
    expect(vi.mocked(getUserLoginProviderStats)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
      expect.any(String),
    );
  });

  it("daysが範囲外の場合 → 400を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/00000000-0000-0000-0000-000000000004/login-stats?days=0`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});

// ===== GET /api/users/:id/login-trends（管理者のみ）=====
describe("GET /api/users/:id/login-trends", () => {
  let app: ReturnType<typeof buildApp>;

  const mockTrends = [
    { date: "2026-03-25", count: 5 },
    { date: "2026-03-26", count: 8 },
    { date: "2026-03-27", count: 3 },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    app = buildApp();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(findUserById).mockResolvedValue({
      ...mockUser,
      id: "00000000-0000-0000-0000-000000000004",
    });
    vi.mocked(getUserDailyLoginTrends).mockResolvedValue(mockTrends);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/login-trends",
      { withAuth: false },
    );
    expect(res.status).toBe(401);
  });

  it("管理者でない場合 → 403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/login-trends",
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("対象ユーザーが存在しない場合 → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(mockAdminUser).mockResolvedValueOnce(null);
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000098/login-trends",
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("日別ログイントレンドとdaysを返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/login-trends",
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; days: number }>();
    expect(body.data).toHaveLength(3);
    expect(body.days).toBe(30);
  });

  it("daysクエリパラメータを受け取る", async () => {
    const res = await app.request(
      new Request(
        `${baseUrl}/api/users/00000000-0000-0000-0000-000000000004/login-trends?days=14`,
        {
          headers: { Authorization: "Bearer mock-token" },
        },
      ),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ days: number }>();
    expect(body.days).toBe(14);
    expect(vi.mocked(getUserDailyLoginTrends)).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000004",
      14,
    );
  });

  it("daysが範囲外の場合 → 400を返す", async () => {
    const res = await app.request(
      new Request(
        `${baseUrl}/api/users/00000000-0000-0000-0000-000000000004/login-trends?days=366`,
        {
          headers: { Authorization: "Bearer mock-token" },
        },
      ),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});

// ===== GET /api/users/me/login-stats =====
describe("GET /api/users/me/login-stats", () => {
  const app = buildApp();

  const mockStats = [
    { provider: "google", count: 5 },
    { provider: "github", count: 2 },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserLoginProviderStats).mockResolvedValue(mockStats);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/login-stats", { withAuth: false });
    expect(res.status).toBe(401);
  });

  it("プロバイダー別統計とdaysを返す", async () => {
    const res = await sendRequest(app, "/api/users/me/login-stats");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; days: number }>();
    expect(body.data).toHaveLength(2);
    expect(body.days).toBe(30);
  });

  it("自分のsubでgetUserLoginProviderStatsを呼ぶ", async () => {
    await sendRequest(app, "/api/users/me/login-stats");
    expect(vi.mocked(getUserLoginProviderStats)).toHaveBeenCalledWith(
      expect.anything(),
      mockUserPayload.sub,
      expect.any(String),
    );
  });

  it("daysクエリパラメータを受け取る", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/me/login-stats?days=7`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ days: number }>();
    expect(body.days).toBe(7);
  });

  it("daysが範囲外の場合 → 400を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/me/login-stats?days=0`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});

// ===== GET /api/users/me/login-trends =====
describe("GET /api/users/me/login-trends", () => {
  const app = buildApp();

  const mockTrends = [
    { date: "2026-04-08", count: 3 },
    { date: "2026-04-09", count: 7 },
    { date: "2026-04-10", count: 2 },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserDailyLoginTrends).mockResolvedValue(mockTrends);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/api/users/me/login-trends", { withAuth: false });
    expect(res.status).toBe(401);
  });

  it("日別ログイントレンドとdaysを返す", async () => {
    const res = await sendRequest(app, "/api/users/me/login-trends");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; days: number }>();
    expect(body.data).toHaveLength(3);
    expect(body.days).toBe(30);
  });

  it("自分のsubでgetUserDailyLoginTrendsを呼ぶ", async () => {
    await sendRequest(app, "/api/users/me/login-trends");
    expect(vi.mocked(getUserDailyLoginTrends)).toHaveBeenCalledWith(
      expect.anything(),
      mockUserPayload.sub,
      30,
    );
  });

  it("daysクエリパラメータを受け取る", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/me/login-trends?days=14`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ days: number }>();
    expect(body.days).toBe(14);
    expect(vi.mocked(getUserDailyLoginTrends)).toHaveBeenCalledWith(
      expect.anything(),
      mockUserPayload.sub,
      14,
    );
  });

  it("daysが範囲外の場合 → 400を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/me/login-trends?days=366`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
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

  it("GET /:id — 不正なID形式 → 400を返す", async () => {
    const res = await sendRequest(app, "/api/users/not-a-uuid");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid user ID format");
  });

  it("GET /:id/tokens — 不正なID形式 → 400を返す（/:id/*ミドルウェア）", async () => {
    const res = await sendRequest(app, "/api/users/not-a-uuid/tokens");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid user ID format");
  });

  it("DELETE /me/connections/:serviceId — 不正なserviceId形式 → 400を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    const res = await sendRequest(app, "/api/users/me/connections/invalid-service-id", {
      method: "DELETE",
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid service ID format");
  });

  it("DELETE /me/tokens/:tokenId — 不正なtokenId形式 → 400を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    const res = await sendRequest(app, "/api/users/me/tokens/invalid-token-id", {
      method: "DELETE",
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid token ID format");
  });

  it("DELETE /:id/tokens/:tokenId — 有効なIDだが不正なtokenId形式 → 400を返す", async () => {
    const res = await sendRequest(
      app,
      "/api/users/00000000-0000-0000-0000-000000000004/tokens/invalid-token-id",
      {
        method: "DELETE",
        origin: "https://admin.0g0.xyz",
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid token ID format");
  });
});
