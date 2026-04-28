/**
 * me.ts ルートの補完テスト
 *
 * users.test.ts で既にカバーされているケースは除外し、
 * 未カバーのブランチのみテストする。
 */
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    findUserById: vi.fn(),
    updateUserProfile: vi.fn(),
    listUserConnections: vi.fn(),
    revokeUserServiceTokens: vi.fn(),
    revokeUserTokens: vi.fn(),
    deleteMcpSessionsByUser: vi.fn(),
    revokeAllBffSessionsByUserId: vi.fn(),
    revokeBffSessionByIdForUser: vi.fn(),
    revokeTokenByIdForUser: vi.fn(),
    revokeOtherUserTokens: vi.fn(),
    listActiveSessionsByUserId: vi.fn(),
    listActiveBffSessionsByUserId: vi.fn(),
    countServicesByOwner: vi.fn(),
    getUserProviders: vi.fn(),
    unlinkProvider: vi.fn(),
    getLoginEventsByUserId: vi.fn(),
    getUserLoginProviderStats: vi.fn(),
    getUserDailyLoginTrends: vi.fn(),
    deleteUser: vi.fn(),
    verifyAccessToken: vi.fn(),
    isAccessTokenRevoked: vi.fn().mockResolvedValue(false),
  };
});

import {
  findUserById,
  updateUserProfile,
  revokeUserTokens,
  deleteMcpSessionsByUser,
  revokeAllBffSessionsByUserId,
  getUserLoginProviderStats,
  getUserDailyLoginTrends,
  verifyAccessToken,
} from "@0g0-id/shared";

import meRoutes from "./me";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

const baseUrl = "https://id.0g0.xyz";
const mockEnv = createMockIdpEnv();

const mockUserPayload = {
  iss: "https://id.0g0.xyz",
  sub: "00000000-0000-0000-0000-000000000002",
  aud: "https://id.0g0.xyz",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  jti: "jti-user",
  kid: "key-1",
  email: "user@example.com",
  role: "user" as const,
};

const mockUser = {
  id: "00000000-0000-0000-0000-000000000002",
  google_sub: "google-sub-1",
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: "user@example.com",
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

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route("/api/users", meRoutes);
  return app;
}

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

// ===== PATCH /api/users/me — updateUserProfile エラーパス =====
describe("PATCH /api/users/me — updateUserProfile エラーパス", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
  });

  it("updateUserProfileが 'User not found' をthrow → 404 NOT_FOUND を返す", async () => {
    vi.mocked(updateUserProfile).mockRejectedValue(new Error("User not found"));
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "New Name" },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("User not found");
  });

  it("updateUserProfileが予期しないエラーをthrow → 500を返す", async () => {
    vi.mocked(updateUserProfile).mockRejectedValue(new Error("D1 connection lost"));
    const res = await sendRequest(app, "/api/users/me", {
      method: "PATCH",
      body: { name: "New Name" },
      origin: "https://user.0g0.xyz",
    });
    expect(res.status).toBe(500);
  });
});

// ===== GET /api/users/me/login-history — 無効なprovider =====
describe("GET /api/users/me/login-history — 無効なproviderパラメータ", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
  });

  it("無効なproviderを指定 → 400 BAD_REQUEST を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/me/login-history?provider=invalid_provider`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid provider");
  });
});

// ===== GET /api/users/me/login-stats — 追加のdaysバリデーション =====
describe("GET /api/users/me/login-stats — 追加のdaysバリデーション", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserLoginProviderStats).mockResolvedValue([]);
  });

  it("days=366（上限超過）→ 400を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/me/login-stats?days=366`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("days=abc（非数値）→ 400を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/me/login-stats?days=abc`, {
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

// ===== GET /api/users/me/login-trends — 追加のdaysバリデーション =====
describe("GET /api/users/me/login-trends — 追加のdaysバリデーション", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserDailyLoginTrends).mockResolvedValue([]);
  });

  it("days=0（下限未満）→ 400を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/me/login-trends?days=0`, {
        headers: { Authorization: "Bearer mock-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("days=-1（負の値）→ 400を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/users/me/login-trends?days=-1`, {
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

// ===== DELETE /api/users/me/tokens — MCP・BFFセッション失効の検証 =====
describe("DELETE /api/users/me/tokens — MCP・BFFセッション失効", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(revokeUserTokens).mockResolvedValue(undefined);
    vi.mocked(deleteMcpSessionsByUser).mockResolvedValue(undefined);
    vi.mocked(revokeAllBffSessionsByUserId).mockResolvedValue(0);
  });

  it("deleteMcpSessionsByUserが呼ばれる", async () => {
    await sendRequest(app, "/api/users/me/tokens", {
      method: "DELETE",
      origin: "https://user.0g0.xyz",
    });
    expect(vi.mocked(deleteMcpSessionsByUser)).toHaveBeenCalledWith(
      expect.anything(),
      mockUserPayload.sub,
    );
  });

  it("revokeAllBffSessionsByUserIdが user_logout_all で呼ばれる", async () => {
    await sendRequest(app, "/api/users/me/tokens", {
      method: "DELETE",
      origin: "https://user.0g0.xyz",
    });
    expect(vi.mocked(revokeAllBffSessionsByUserId)).toHaveBeenCalledWith(
      expect.anything(),
      mockUserPayload.sub,
      "user_logout_all",
    );
  });

  it("revokeUserTokens → deleteMcpSessionsByUser → revokeAllBffSessionsByUserId の順で呼ばれる", async () => {
    const callOrder: string[] = [];
    vi.mocked(revokeUserTokens).mockImplementation(async () => {
      callOrder.push("revokeTokens");
    });
    vi.mocked(deleteMcpSessionsByUser).mockImplementation(async () => {
      callOrder.push("deleteMcp");
    });
    vi.mocked(revokeAllBffSessionsByUserId).mockImplementation(async () => {
      callOrder.push("revokeBff");
      return 0;
    });

    await sendRequest(app, "/api/users/me/tokens", {
      method: "DELETE",
      origin: "https://user.0g0.xyz",
    });

    expect(callOrder).toEqual(["revokeTokens", "deleteMcp", "revokeBff"]);
  });
});
