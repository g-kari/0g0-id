import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const { restErrorBody, REST_ERROR_CODES } =
    await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    restErrorBody,
    REST_ERROR_CODES,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    countUsers: vi.fn(),
    countAdminUsers: vi.fn(),
    countServices: vi.fn(),
    countActiveRefreshTokens: vi.fn(),
    countRecentLoginEvents: vi.fn(),
    getLoginEventProviderStats: vi.fn(),
    getLoginEventCountryStats: vi.fn(),
    getDailyLoginTrends: vi.fn(),
    verifyAccessToken: vi.fn(),
    isAccessTokenRevoked: vi.fn().mockResolvedValue(false),
    findUserById: vi.fn(),
    getServiceTokenStats: vi.fn(),
    getSuspiciousMultiCountryLogins: vi.fn(),
    getDailyUserRegistrations: vi.fn(),
    getActiveUserStats: vi.fn(),
    getDailyActiveUsers: vi.fn(),
    getLoginEventIpStats: vi.fn(),
    getLoginEventUserAgentStats: vi.fn(),
    getRecentLoginEvents: vi.fn(),
    getBffSessionDbscStats: vi.fn(),
    parseDays: vi.fn(),
  };
});

import {
  countUsers,
  countAdminUsers,
  countServices,
  countActiveRefreshTokens,
  countRecentLoginEvents,
  getLoginEventProviderStats,
  getLoginEventCountryStats,
  getDailyLoginTrends,
  verifyAccessToken,
  findUserById,
  getServiceTokenStats,
  getSuspiciousMultiCountryLogins,
  getDailyUserRegistrations,
  getActiveUserStats,
  getDailyActiveUsers,
  getLoginEventIpStats,
  getLoginEventUserAgentStats,
  getRecentLoginEvents,
  getBffSessionDbscStats,
  parseDays,
} from "@0g0-id/shared";

import metricsRoutes from "./metrics";
import { createMockIdpEnv } from "../../../../packages/shared/src/db/test-helpers";

const baseUrl = "https://id.0g0.xyz";

const mockEnv = createMockIdpEnv();

const mockAdminPayload = {
  iss: "https://id.0g0.xyz",
  sub: "admin-user-id",
  aud: "https://id.0g0.xyz",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  jti: "jti-admin",
  kid: "key-1",
  email: "admin@example.com",
  role: "admin" as const,
};

const mockUserPayload = {
  ...mockAdminPayload,
  sub: "regular-user-id",
  email: "user@example.com",
  role: "user" as const,
};

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route("/api/metrics", metricsRoutes);
  return app;
}

function makeRequest(path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return new Request(`${baseUrl}${path}`, { headers });
}

describe("GET /api/metrics", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findUserById).mockResolvedValue({
      id: "admin-user-id",
      email: "admin@example.com",
      role: "admin",
      banned_at: null,
    } as any);
  });

  it("Authorizationヘッダーなしで401を返す", async () => {
    const res = await app.request(makeRequest("/api/metrics"), undefined, mockEnv);
    expect(res.status).toBe(401);
  });

  it("一般ユーザーのトークンで403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);

    const res = await app.request(makeRequest("/api/metrics", "user-token"), undefined, mockEnv);
    expect(res.status).toBe(403);
  });

  it("管理者トークンでメトリクスデータを返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    // 1回目: 全ユーザー数, 2回目: BAN済みユーザー数
    vi.mocked(countUsers).mockResolvedValueOnce(100).mockResolvedValueOnce(3);
    vi.mocked(countAdminUsers).mockResolvedValue(5);
    vi.mocked(countServices).mockResolvedValue(10);
    vi.mocked(countActiveRefreshTokens).mockResolvedValue(42);
    vi.mocked(countRecentLoginEvents).mockResolvedValueOnce(13).mockResolvedValueOnce(87);
    vi.mocked(getLoginEventProviderStats).mockResolvedValue([
      { provider: "google", count: 60 },
      { provider: "line", count: 20 },
      { provider: "github", count: 7 },
    ]);
    vi.mocked(getLoginEventCountryStats).mockResolvedValue([
      { country: "JP", count: 50 },
      { country: "US", count: 30 },
    ]);

    const res = await app.request(makeRequest("/api/metrics", "admin-token"), undefined, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json<{
      data: {
        total_users: number;
        admin_users: number;
        banned_users: number;
        total_services: number;
        active_sessions: number;
        recent_logins_24h: number;
        recent_logins_7d: number;
        login_provider_stats_7d: { provider: string; count: number }[];
        login_country_stats_7d: { country: string; count: number }[];
      };
    }>();
    expect(body.data.total_users).toBe(100);
    expect(body.data.admin_users).toBe(5);
    expect(body.data.banned_users).toBe(3);
    expect(body.data.total_services).toBe(10);
    expect(body.data.active_sessions).toBe(42);
    expect(body.data.recent_logins_24h).toBe(13);
    expect(body.data.recent_logins_7d).toBe(87);
    expect(body.data.login_provider_stats_7d).toEqual([
      { provider: "google", count: 60 },
      { provider: "line", count: 20 },
      { provider: "github", count: 7 },
    ]);
    expect(body.data.login_country_stats_7d).toEqual([
      { country: "JP", count: 50 },
      { country: "US", count: 30 },
    ]);
  });

  it("管理者トークンでDBへの各カウント関数が呼ばれる", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(countUsers).mockResolvedValue(0);
    vi.mocked(countAdminUsers).mockResolvedValue(0);
    vi.mocked(countServices).mockResolvedValue(0);
    vi.mocked(countActiveRefreshTokens).mockResolvedValue(0);
    vi.mocked(countRecentLoginEvents).mockResolvedValue(0);
    vi.mocked(getLoginEventProviderStats).mockResolvedValue([]);
    vi.mocked(getLoginEventCountryStats).mockResolvedValue([]);

    await app.request(makeRequest("/api/metrics", "admin-token"), undefined, mockEnv);

    expect(vi.mocked(countUsers)).toHaveBeenCalledWith(mockEnv.DB);
    expect(vi.mocked(countUsers)).toHaveBeenCalledWith(mockEnv.DB, { banned: true });
    expect(vi.mocked(countAdminUsers)).toHaveBeenCalledWith(mockEnv.DB);
    expect(vi.mocked(countServices)).toHaveBeenCalledWith(mockEnv.DB);
    expect(vi.mocked(countActiveRefreshTokens)).toHaveBeenCalledWith(mockEnv.DB);
    expect(vi.mocked(countRecentLoginEvents)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getLoginEventProviderStats)).toHaveBeenCalledWith(
      mockEnv.DB,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
    expect(vi.mocked(getLoginEventCountryStats)).toHaveBeenCalledWith(
      mockEnv.DB,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it("countRecentLoginEventsには24h・7d両方の日時が渡される", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(countUsers).mockResolvedValue(0);
    vi.mocked(countAdminUsers).mockResolvedValue(0);
    vi.mocked(countServices).mockResolvedValue(0);
    vi.mocked(countActiveRefreshTokens).mockResolvedValue(0);
    vi.mocked(countRecentLoginEvents).mockResolvedValue(0);
    vi.mocked(getLoginEventProviderStats).mockResolvedValue([]);
    vi.mocked(getLoginEventCountryStats).mockResolvedValue([]);

    const before = Date.now();
    await app.request(makeRequest("/api/metrics", "admin-token"), undefined, mockEnv);
    const after = Date.now();

    const calls = vi.mocked(countRecentLoginEvents).mock.calls;
    expect(calls).toHaveLength(2);

    // 1回目: 24h前
    const since24hMs = new Date(calls[0][1]).getTime();
    expect(since24hMs).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000);
    expect(since24hMs).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000);

    // 2回目: 7d前
    const since7dMs = new Date(calls[1][1]).getTime();
    expect(since7dMs).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000);
    expect(since7dMs).toBeLessThanOrEqual(after - 7 * 24 * 60 * 60 * 1000);
  });

  it("getLoginEventProviderStatsには7d前の日時が渡される", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(countUsers).mockResolvedValue(0);
    vi.mocked(countAdminUsers).mockResolvedValue(0);
    vi.mocked(countServices).mockResolvedValue(0);
    vi.mocked(countActiveRefreshTokens).mockResolvedValue(0);
    vi.mocked(countRecentLoginEvents).mockResolvedValue(0);
    vi.mocked(getLoginEventProviderStats).mockResolvedValue([]);
    vi.mocked(getLoginEventCountryStats).mockResolvedValue([]);

    const before = Date.now();
    await app.request(makeRequest("/api/metrics", "admin-token"), undefined, mockEnv);
    const after = Date.now();

    const calledSince = vi.mocked(getLoginEventProviderStats).mock.calls[0][1];
    const calledSinceMs = new Date(calledSince).getTime();
    expect(calledSinceMs).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000);
    expect(calledSinceMs).toBeLessThanOrEqual(after - 7 * 24 * 60 * 60 * 1000);
  });

  it("プロバイダー統計が空の場合も正常に返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(countUsers).mockResolvedValue(0);
    vi.mocked(countAdminUsers).mockResolvedValue(0);
    vi.mocked(countServices).mockResolvedValue(0);
    vi.mocked(countActiveRefreshTokens).mockResolvedValue(0);
    vi.mocked(countRecentLoginEvents).mockResolvedValue(0);
    vi.mocked(getLoginEventProviderStats).mockResolvedValue([]);
    vi.mocked(getLoginEventCountryStats).mockResolvedValue([]);

    const res = await app.request(makeRequest("/api/metrics", "admin-token"), undefined, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json<{ data: { login_provider_stats_7d: unknown[] } }>();
    expect(body.data.login_provider_stats_7d).toEqual([]);
  });

  it("無効なトークンで401を返す", async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error("invalid token"));

    const res = await app.request(makeRequest("/api/metrics", "invalid-token"), undefined, mockEnv);
    expect(res.status).toBe(401);
  });

  it("DB例外時に500を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(countUsers).mockRejectedValue(new Error("DB connection error"));

    const res = await app.request(makeRequest("/api/metrics", "admin-token"), undefined, mockEnv);
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("GET /api/metrics/login-trends", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findUserById).mockResolvedValue({
      id: "admin-user-id",
      email: "admin@example.com",
      role: "admin",
      banned_at: null,
    } as any);
  });

  it("Authorizationヘッダーなしで401を返す", async () => {
    const res = await app.request(makeRequest("/api/metrics/login-trends"), undefined, mockEnv);
    expect(res.status).toBe(401);
  });

  it("一般ユーザーのトークンで403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);

    const res = await app.request(
      makeRequest("/api/metrics/login-trends", "user-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(403);
  });

  it("管理者トークンで日別ログイントレンドを返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getDailyLoginTrends).mockResolvedValue([
      { date: "2026-03-20", count: 12 },
      { date: "2026-03-21", count: 8 },
      { date: "2026-03-22", count: 15 },
    ]);

    const res = await app.request(
      makeRequest("/api/metrics/login-trends", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ data: { date: string; count: number }[]; days: number }>();
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toEqual({ date: "2026-03-20", count: 12 });
    expect(body.days).toBe(30);
  });

  it("daysパラメーターが指定された場合getDailyLoginTrendsに渡される", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue({ days: 7 });
    vi.mocked(getDailyLoginTrends).mockResolvedValue([]);

    await app.request(
      makeRequest("/api/metrics/login-trends?days=7", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockEnv.DB, 7);
  });

  it("daysが90を超える場合は90にクランプされる", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue({ days: 90 });
    vi.mocked(getDailyLoginTrends).mockResolvedValue([]);

    await app.request(
      makeRequest("/api/metrics/login-trends?days=200", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockEnv.DB, 90);
  });

  it("daysが1未満の場合は1にクランプされる", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue({ days: 1 });
    vi.mocked(getDailyLoginTrends).mockResolvedValue([]);

    await app.request(
      makeRequest("/api/metrics/login-trends?days=0", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockEnv.DB, 1);
  });

  it("daysが未指定の場合はデフォルト30が使われる", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getDailyLoginTrends).mockResolvedValue([]);

    const res = await app.request(
      makeRequest("/api/metrics/login-trends", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(vi.mocked(getDailyLoginTrends)).toHaveBeenCalledWith(mockEnv.DB, 30);
    const body = await res.json<{ days: number }>();
    expect(body.days).toBe(30);
  });

  it("データが空の場合も200で空配列を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getDailyLoginTrends).mockResolvedValue([]);

    const res = await app.request(
      makeRequest("/api/metrics/login-trends", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toEqual([]);
  });

  it("DB例外時に500を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue(undefined);
    vi.mocked(getDailyLoginTrends).mockRejectedValue(new Error("DB connection error"));

    const res = await app.request(
      makeRequest("/api/metrics/login-trends", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("GET /api/metrics - 国別ログイン統計", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findUserById).mockResolvedValue({
      id: "admin-user-id",
      email: "admin@example.com",
      role: "admin",
      banned_at: null,
    } as any);
    // 共通のデフォルトモック
    vi.mocked(countUsers).mockResolvedValue(0);
    vi.mocked(countAdminUsers).mockResolvedValue(0);
    vi.mocked(countServices).mockResolvedValue(0);
    vi.mocked(countActiveRefreshTokens).mockResolvedValue(0);
    vi.mocked(countRecentLoginEvents).mockResolvedValue(0);
    vi.mocked(getLoginEventProviderStats).mockResolvedValue([]);
  });

  it("login_country_stats_7dが国別統計を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getLoginEventCountryStats).mockResolvedValue([
      { country: "JP", count: 80 },
      { country: "US", count: 15 },
      { country: "unknown", count: 5 },
    ]);

    const res = await app.request(makeRequest("/api/metrics", "admin-token"), undefined, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json<{
      data: { login_country_stats_7d: { country: string; count: number }[] };
    }>();
    expect(body.data.login_country_stats_7d).toEqual([
      { country: "JP", count: 80 },
      { country: "US", count: 15 },
      { country: "unknown", count: 5 },
    ]);
  });

  it("getLoginEventCountryStatsには7d前の日時が渡される", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getLoginEventCountryStats).mockResolvedValue([]);

    const before = Date.now();
    await app.request(makeRequest("/api/metrics", "admin-token"), undefined, mockEnv);
    const after = Date.now();

    const calledSince = vi.mocked(getLoginEventCountryStats).mock.calls[0][1];
    const calledSinceMs = new Date(calledSince).getTime();
    expect(calledSinceMs).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000);
    expect(calledSinceMs).toBeLessThanOrEqual(after - 7 * 24 * 60 * 60 * 1000);
  });

  it("国別統計が空の場合も正常に返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getLoginEventCountryStats).mockResolvedValue([]);

    const res = await app.request(makeRequest("/api/metrics", "admin-token"), undefined, mockEnv);

    expect(res.status).toBe(200);
    const body = await res.json<{ data: { login_country_stats_7d: unknown[] } }>();
    expect(body.data.login_country_stats_7d).toEqual([]);
  });
});

describe("GET /api/metrics/services", () => {
  it("認証なしで 401 を返す", async () => {
    const app = buildApp();
    const res = await app.request(makeRequest("/api/metrics/services"), undefined, mockEnv);
    expect(res.status).toBe(401);
  });

  it("管理者以外で 403 を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockUserPayload);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/services", "user-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(403);
  });

  it("サービス別トークン統計を返す", async () => {
    const mockStats = [
      {
        service_id: "svc-1",
        service_name: "Service A",
        authorized_user_count: 5,
        active_token_count: 8,
      },
    ];
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getServiceTokenStats).mockResolvedValueOnce(mockStats);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/services", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: typeof mockStats }>();
    expect(body.data).toEqual(mockStats);
    expect(getServiceTokenStats).toHaveBeenCalledWith(mockEnv.DB);
  });

  it("サービスが存在しない場合は空配列を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getServiceTokenStats).mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/services", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: [] }>();
    expect(body.data).toEqual([]);
  });

  it("DB例外時に500を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getServiceTokenStats).mockRejectedValueOnce(new Error("DB connection error"));
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/services", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("GET /api/metrics/suspicious-logins", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findUserById).mockResolvedValue({
      id: "admin-user-id",
      email: "admin@example.com",
      role: "admin",
      banned_at: null,
    } as any);
  });

  it("認証なしで 401 を返す", async () => {
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/suspicious-logins"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(401);
  });

  it("管理者以外で 403 を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockUserPayload);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/suspicious-logins", "user-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(403);
  });

  it("複数国ログインの疑いがあるユーザー一覧を返す", async () => {
    const mockData = [
      { user_id: "user-1", country_count: 3, countries: "JP,US,DE" },
      { user_id: "user-2", country_count: 2, countries: "JP,KR" },
    ];
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getSuspiciousMultiCountryLogins).mockResolvedValueOnce(mockData);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/suspicious-logins", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: typeof mockData;
      meta: { hours: number; min_countries: number };
    }>();
    expect(body.data).toEqual(mockData);
    expect(body.meta.hours).toBe(24);
    expect(body.meta.min_countries).toBe(2);
  });

  it("デフォルトで hours=24・min_countries=2 が使われる", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getSuspiciousMultiCountryLogins).mockResolvedValueOnce([]);
    const app = buildApp();

    const before = Date.now();
    await app.request(
      makeRequest("/api/metrics/suspicious-logins", "admin-token"),
      undefined,
      mockEnv,
    );
    const after = Date.now();

    const [, calledSince, calledMin] = vi.mocked(getSuspiciousMultiCountryLogins).mock.calls[0];
    const calledSinceMs = new Date(calledSince).getTime();
    expect(calledSinceMs).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000);
    expect(calledSinceMs).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000);
    expect(calledMin).toBe(2);
  });

  it("hours パラメータを指定できる", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getSuspiciousMultiCountryLogins).mockResolvedValueOnce([]);
    const app = buildApp();

    const res = await app.request(
      makeRequest("/api/metrics/suspicious-logins?hours=48", "admin-token"),
      undefined,
      mockEnv,
    );
    const body = await res.json<{ meta: { hours: number } }>();
    expect(body.meta.hours).toBe(48);
  });

  it("hours が 168 を超える場合は 168 にクランプされる", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getSuspiciousMultiCountryLogins).mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/suspicious-logins?hours=9999", "admin-token"),
      undefined,
      mockEnv,
    );
    const body = await res.json<{ meta: { hours: number } }>();
    expect(body.meta.hours).toBe(168);
  });

  it("hours が 1 未満の場合は 1 にクランプされる", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getSuspiciousMultiCountryLogins).mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/suspicious-logins?hours=0", "admin-token"),
      undefined,
      mockEnv,
    );
    const body = await res.json<{ meta: { hours: number } }>();
    expect(body.meta.hours).toBe(1);
  });

  it("min_countries パラメータを指定できる", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getSuspiciousMultiCountryLogins).mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/suspicious-logins?min_countries=3", "admin-token"),
      undefined,
      mockEnv,
    );
    const body = await res.json<{ meta: { min_countries: number } }>();
    expect(body.meta.min_countries).toBe(3);
    expect(getSuspiciousMultiCountryLogins).toHaveBeenCalledWith(mockEnv.DB, expect.any(String), 3);
  });

  it("min_countries が 10 を超える場合は 10 にクランプされる", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getSuspiciousMultiCountryLogins).mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/suspicious-logins?min_countries=99", "admin-token"),
      undefined,
      mockEnv,
    );
    const body = await res.json<{ meta: { min_countries: number } }>();
    expect(body.meta.min_countries).toBe(10);
  });

  it("該当者がいない場合は空配列を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getSuspiciousMultiCountryLogins).mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/suspicious-logins", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toEqual([]);
  });

  it("DB例外時に500を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getSuspiciousMultiCountryLogins).mockRejectedValueOnce(
      new Error("DB connection error"),
    );
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/suspicious-logins", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("GET /api/metrics/user-registrations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findUserById).mockResolvedValue({
      id: "admin-user-id",
      email: "admin@example.com",
      role: "admin",
      banned_at: null,
    } as any);
  });

  it("認証なしで 401 を返す", async () => {
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/user-registrations"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(401);
  });

  it("管理者以外で 403 を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockUserPayload);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/user-registrations", "user-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(403);
  });

  it("日別ユーザー登録数を返す", async () => {
    const mockData = [
      { date: "2026-03-20", count: 3 },
      { date: "2026-03-21", count: 7 },
      { date: "2026-03-22", count: 2 },
    ];
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getDailyUserRegistrations).mockResolvedValueOnce(mockData);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/user-registrations", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: typeof mockData; days: number }>();
    expect(body.data).toEqual(mockData);
    expect(body.days).toBe(30);
  });

  it("daysパラメーターが指定された場合 getDailyUserRegistrations に渡される", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue({ days: 7 });
    vi.mocked(getDailyUserRegistrations).mockResolvedValueOnce([]);
    const app = buildApp();
    await app.request(
      makeRequest("/api/metrics/user-registrations?days=7", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(vi.mocked(getDailyUserRegistrations)).toHaveBeenCalledWith(mockEnv.DB, 7);
  });

  it("days が未指定の場合はデフォルト 30 が使われる", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getDailyUserRegistrations).mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/user-registrations", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(vi.mocked(getDailyUserRegistrations)).toHaveBeenCalledWith(mockEnv.DB, 30);
    const body = await res.json<{ days: number }>();
    expect(body.days).toBe(30);
  });

  it("days が 90 を超える場合は 90 にクランプされる", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue({ days: 90 });
    vi.mocked(getDailyUserRegistrations).mockResolvedValueOnce([]);
    const app = buildApp();
    await app.request(
      makeRequest("/api/metrics/user-registrations?days=200", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(vi.mocked(getDailyUserRegistrations)).toHaveBeenCalledWith(mockEnv.DB, 90);
  });

  it("days が 1 未満の場合は 1 にクランプされる", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue({ days: 1 });
    vi.mocked(getDailyUserRegistrations).mockResolvedValueOnce([]);
    const app = buildApp();
    await app.request(
      makeRequest("/api/metrics/user-registrations?days=0", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(vi.mocked(getDailyUserRegistrations)).toHaveBeenCalledWith(mockEnv.DB, 1);
  });

  it("登録が0件の場合も 200 で空配列を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(getDailyUserRegistrations).mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/user-registrations", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[] }>();
    expect(body.data).toEqual([]);
  });

  it("DB例外時に500を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValueOnce(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue(undefined);
    vi.mocked(getDailyUserRegistrations).mockRejectedValueOnce(new Error("DB connection error"));
    const app = buildApp();
    const res = await app.request(
      makeRequest("/api/metrics/user-registrations", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("GET /api/metrics/active-users", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findUserById).mockResolvedValue({
      id: "admin-user-id",
      email: "admin@example.com",
      role: "admin",
      banned_at: null,
    } as any);
  });

  it("Authorizationヘッダーなしで401を返す", async () => {
    const res = await app.request(makeRequest("/api/metrics/active-users"), undefined, mockEnv);
    expect(res.status).toBe(401);
  });

  it("一般ユーザーのトークンで403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);

    const res = await app.request(
      makeRequest("/api/metrics/active-users", "user-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(403);
  });

  it("管理者トークンでDAU/WAU/MAUデータを返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getActiveUserStats).mockResolvedValue({ dau: 10, wau: 50, mau: 200 } as any);

    const res = await app.request(
      makeRequest("/api/metrics/active-users", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ data: { dau: number; wau: number; mau: number } }>();
    expect(body.data).toEqual({ dau: 10, wau: 50, mau: 200 });
  });

  it("getActiveUserStatsをDBと共に呼び出す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getActiveUserStats).mockResolvedValue({ dau: 0, wau: 0, mau: 0 } as any);

    await app.request(makeRequest("/api/metrics/active-users", "admin-token"), undefined, mockEnv);

    expect(getActiveUserStats).toHaveBeenCalledWith(mockEnv.DB);
  });

  it("DB例外時に500を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getActiveUserStats).mockRejectedValue(new Error("DB connection error"));

    const res = await app.request(
      makeRequest("/api/metrics/active-users", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("GET /api/metrics/active-users/daily", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findUserById).mockResolvedValue({
      id: "admin-user-id",
      email: "admin@example.com",
      role: "admin",
      banned_at: null,
    } as any);
  });

  it("Authorizationヘッダーなしで401を返す", async () => {
    const res = await app.request(
      makeRequest("/api/metrics/active-users/daily"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(401);
  });

  it("一般ユーザーのトークンで403を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);

    const res = await app.request(
      makeRequest("/api/metrics/active-users/daily", "user-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(403);
  });

  it("daysパラメータなしでデフォルト30日のデータを返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue(undefined);
    vi.mocked(getDailyActiveUsers).mockResolvedValue([
      { date: "2026-04-01", active_users: 5 },
    ] as any);

    const res = await app.request(
      makeRequest("/api/metrics/active-users/daily", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown; days: number }>();
    expect(body.days).toBe(30);
    expect(body.data).toEqual([{ date: "2026-04-01", active_users: 5 }]);
  });

  it("days=7で7日分のデータを返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue({ days: 7 });
    vi.mocked(getDailyActiveUsers).mockResolvedValue([] as any);

    const res = await app.request(
      makeRequest("/api/metrics/active-users/daily?days=7", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown; days: number }>();
    expect(body.days).toBe(7);
    expect(getDailyActiveUsers).toHaveBeenCalledWith(mockEnv.DB, 7);
  });

  it("daysが非整数文字列の場合400エラーを返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue({
      error: { code: "INVALID_REQUEST", message: "days must be an integer between 1 and 90" },
    });

    const res = await app.request(
      makeRequest("/api/metrics/active-users/daily?days=abc", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("days=0で範囲外の400エラーを返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue({
      error: { code: "INVALID_REQUEST", message: "days must be an integer between 1 and 90" },
    });

    const res = await app.request(
      makeRequest("/api/metrics/active-users/daily?days=0", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("days=91で範囲外の400エラーを返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue({
      error: { code: "INVALID_REQUEST", message: "days must be an integer between 1 and 90" },
    });

    const res = await app.request(
      makeRequest("/api/metrics/active-users/daily?days=91", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("エラー時にgetDailyActiveUsersを呼び出さない", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue({
      error: { code: "INVALID_REQUEST", message: "days must be an integer between 1 and 90" },
    });

    await app.request(
      makeRequest("/api/metrics/active-users/daily?days=abc", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(getDailyActiveUsers).not.toHaveBeenCalled();
  });

  it("DB例外時に500を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(parseDays).mockReturnValue(undefined);
    vi.mocked(getDailyActiveUsers).mockRejectedValue(new Error("DB connection error"));

    const res = await app.request(
      makeRequest("/api/metrics/active-users/daily", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("GET /api/metrics/ip-stats", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findUserById).mockResolvedValue({
      id: "admin-user-id",
      email: "admin@example.com",
      role: "admin",
      banned_at: null,
    } as any);
  });

  it("管理者トークンで IPアドレス別統計を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getLoginEventIpStats).mockResolvedValue([
      { ip_address: "203.0.113.1", count: 12, last_seen: "2026-04-17T00:00:00Z" },
      { ip_address: "198.51.100.2", count: 5, last_seen: "2026-04-16T12:00:00Z" },
    ]);

    const res = await app.request(
      makeRequest("/api/metrics/ip-stats?days=7&limit=20", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      data: { ip_address: string; count: number; last_seen: string }[];
      meta: { days: number; limit: number };
    }>();
    expect(body.data).toHaveLength(2);
    expect(body.meta).toEqual({ days: 7, limit: 20 });
    expect(vi.mocked(getLoginEventIpStats)).toHaveBeenCalledWith(
      mockEnv.DB,
      expect.any(String),
      20,
    );
  });

  it("days が非数値の場合 400 INVALID_PARAMETER を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);

    const res = await app.request(
      makeRequest("/api/metrics/ip-stats?days=abc", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_PARAMETER");
    expect(getLoginEventIpStats).not.toHaveBeenCalled();
  });
});

describe("GET /api/metrics/user-agent-stats", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findUserById).mockResolvedValue({
      id: "admin-user-id",
      email: "admin@example.com",
      role: "admin",
      banned_at: null,
    } as any);
  });

  it("管理者トークンで User-Agent別統計を返す（デフォルトは days=7, limit=20）", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getLoginEventUserAgentStats).mockResolvedValue([
      { user_agent: "Mozilla/5.0 Chrome/120", count: 42 },
    ]);

    const res = await app.request(
      makeRequest("/api/metrics/user-agent-stats", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      data: { user_agent: string; count: number }[];
      meta: { days: number; limit: number };
    }>();
    expect(body.data).toHaveLength(1);
    expect(body.meta).toEqual({ days: 7, limit: 20 });
    expect(vi.mocked(getLoginEventUserAgentStats)).toHaveBeenCalledWith(
      mockEnv.DB,
      expect.any(String),
      20,
    );
  });

  it("limit が範囲外の場合 400 INVALID_PARAMETER を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);

    const res = await app.request(
      makeRequest("/api/metrics/user-agent-stats?limit=101", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_PARAMETER");
    expect(getLoginEventUserAgentStats).not.toHaveBeenCalled();
  });
});

describe("GET /api/metrics/recent-events", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findUserById).mockResolvedValue({
      id: "admin-user-id",
      email: "admin@example.com",
      role: "admin",
      banned_at: null,
    } as any);
  });

  it("管理者トークンで直近ログインイベント一覧を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getRecentLoginEvents).mockResolvedValue({
      events: [
        {
          id: "e1",
          user_id: "u1",
          provider: "google",
          ip_address: "1.2.3.4",
          user_agent: "Mozilla/5.0",
          country: "JP",
          created_at: "2026-04-17T00:00:00Z",
        },
      ],
      total: 1,
    });

    const res = await app.request(
      makeRequest("/api/metrics/recent-events?limit=50&offset=0", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      data: unknown[];
      meta: { limit: number; offset: number; total: number };
    }>();
    expect(body.data).toHaveLength(1);
    expect(body.meta).toEqual({ limit: 50, offset: 0, total: 1 });
    expect(vi.mocked(getRecentLoginEvents)).toHaveBeenCalledWith(mockEnv.DB, 50, 0);
  });

  it("offset が負数（非数値扱い）の場合 400 INVALID_PARAMETER を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);

    const res = await app.request(
      makeRequest("/api/metrics/recent-events?offset=-1", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_PARAMETER");
    expect(getRecentLoginEvents).not.toHaveBeenCalled();
  });
});

describe("GET /api/metrics/dbsc-bindings", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findUserById).mockResolvedValue({
      id: "admin-user-id",
      email: "admin@example.com",
      role: "admin",
      banned_at: null,
    } as any);
  });

  it("管理者トークンで DBSC 端末バインド集計を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getBffSessionDbscStats).mockResolvedValue({
      total: 120,
      device_bound: 94,
      unbound: 26,
      by_bff_origin: [
        { bff_origin: "https://admin.0g0.xyz", total: 12, device_bound: 12, unbound: 0 },
        { bff_origin: "https://user.0g0.xyz", total: 108, device_bound: 82, unbound: 26 },
      ],
    });

    const res = await app.request(
      makeRequest("/api/metrics/dbsc-bindings", "admin-token"),
      undefined,
      mockEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      data: {
        total: number;
        device_bound: number;
        unbound: number;
        by_bff_origin: Array<{
          bff_origin: string;
          total: number;
          device_bound: number;
          unbound: number;
        }>;
      };
    }>();
    expect(body.data.total).toBe(120);
    expect(body.data.device_bound).toBe(94);
    expect(body.data.unbound).toBe(26);
    expect(body.data.by_bff_origin).toHaveLength(2);
    expect(vi.mocked(getBffSessionDbscStats)).toHaveBeenCalledWith(mockEnv.DB);
  });

  it("未認証（トークンなし）は 401 を返し集計関数を呼ばない", async () => {
    const res = await app.request(makeRequest("/api/metrics/dbsc-bindings"), undefined, mockEnv);
    expect(res.status).toBe(401);
    expect(getBffSessionDbscStats).not.toHaveBeenCalled();
  });

  it("非管理者ロールは 403 を返し集計関数を呼ばない", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockUserPayload);
    vi.mocked(findUserById).mockResolvedValue({
      id: "regular-user-id",
      email: "user@example.com",
      role: "user",
      banned_at: null,
    } as any);

    const res = await app.request(
      makeRequest("/api/metrics/dbsc-bindings", "user-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(403);
    expect(getBffSessionDbscStats).not.toHaveBeenCalled();
  });

  it("集計関数が throw した場合は 500 INTERNAL_ERROR を返す", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockAdminPayload);
    vi.mocked(getBffSessionDbscStats).mockRejectedValue(new Error("db down"));

    const res = await app.request(
      makeRequest("/api/metrics/dbsc-bindings", "admin-token"),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});
