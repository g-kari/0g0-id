import { describe, it, expect, vi } from "vite-plus/test";
import { encodeSession } from "@0g0-id/shared";
import { Hono } from "hono";

import metricsRoutes from "./metrics";

const SESSION_COOKIE = "__Host-admin-session";
const baseUrl = "https://admin.0g0.xyz";

async function makeSessionCookie(role: "admin" | "user" = "admin"): Promise<string> {
  const session = {
    session_id: "00000000-0000-0000-0000-000000000000",
    access_token: "mock-access-token",
    refresh_token: "mock-refresh-token",
    user: { id: "admin-user-id", email: "admin@example.com", name: "Admin", role },
  };
  return encodeSession(session, "test-secret");
}

function buildApp(idpFetch: (req: Request) => Promise<Response>) {
  const app = new Hono<{
    Bindings: { IDP: { fetch: typeof idpFetch }; IDP_ORIGIN: string; SESSION_SECRET: string };
  }>();
  app.route("/api/metrics", metricsRoutes);
  return {
    request: (path: string, init?: RequestInit) => {
      const req = new Request(`${baseUrl}${path}`, init);
      return app.request(req, undefined, {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: "test-secret",
      });
    },
  };
}

function mockIdp(status: number, body: unknown): (req: Request) => Promise<Response> {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const mockMetrics = {
  total_users: 100,
  admin_users: 5,
  total_services: 10,
  active_sessions: 42,
};

describe("admin BFF — /api/metrics", () => {
  describe("GET / — メトリクス取得", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/metrics");
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPへプロキシしてメトリクスを返す", async () => {
      const idpFetch = mockIdp(200, { data: mockMetrics });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/metrics", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockMetrics }>();
      expect(body.data.total_users).toBe(100);
      expect(body.data.admin_users).toBe(5);
      expect(body.data.total_services).toBe(10);
      expect(body.data.active_sessions).toBe(42);
      expect(idpFetch).toHaveBeenCalledOnce();
    });

    it("IdP への呼び出しURLに /api/metrics が含まれる", async () => {
      const idpFetch = mockIdp(200, { data: mockMetrics });
      const app = buildApp(idpFetch);

      await app.request("/api/metrics", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const calledUrl = vi.mocked(idpFetch).mock.calls[0][0].url;
      expect(calledUrl).toContain("/api/metrics");
    });

    it("IdP が403を返した場合は403をプロキシする", async () => {
      const idpFetch = mockIdp(403, { error: { code: "FORBIDDEN", message: "Forbidden" } });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/metrics", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(403);
    });

    it("IdP が500を返した場合は500をプロキシする", async () => {
      const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR", message: "Server error" } });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/metrics", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /login-trends — 日別ログイントレンド", () => {
    const mockTrends = [
      { date: "2024-01-01", count: 10 },
      { date: "2024-01-02", count: 15 },
    ];

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/metrics/login-trends");
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPへプロキシしてトレンドデータを返す", async () => {
      const idpFetch = mockIdp(200, { data: mockTrends, days: 30 });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/metrics/login-trends", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockTrends; days: number }>();
      expect(body.data).toHaveLength(2);
      expect(body.data[0].count).toBe(10);
      expect(idpFetch).toHaveBeenCalledOnce();
    });

    it("IdP への呼び出しURLに /api/metrics/login-trends が含まれる", async () => {
      const idpFetch = mockIdp(200, { data: mockTrends, days: 30 });
      const app = buildApp(idpFetch);

      await app.request("/api/metrics/login-trends", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const calledUrl = vi.mocked(idpFetch).mock.calls[0][0].url;
      expect(calledUrl).toContain("/api/metrics/login-trends");
    });

    it("daysクエリパラメータをIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: mockTrends, days: 7 });
      const app = buildApp(idpFetch);

      await app.request("/api/metrics/login-trends?days=7", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.searchParams.get("days")).toBe("7");
    });

    it("IdP が500を返した場合は500をプロキシする", async () => {
      const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR", message: "Server error" } });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/metrics/login-trends", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });

    it("不正なdays（abc）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/login-trends?days=abc", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("days=0（範囲外）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/login-trends?days=0", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });
  });

  describe("GET /services — サービス別統計", () => {
    it("セッションなしで 401 を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/services");
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("IdP にリクエストをプロキシする", async () => {
      const mockStats = [
        {
          service_id: "svc-1",
          service_name: "Service A",
          authorized_user_count: 3,
          active_token_count: 5,
        },
      ];
      const idpFetch = mockIdp(200, { data: mockStats });
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/services", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockStats }>();
      expect(body.data).toEqual(mockStats);
      const calledUrl = vi.mocked(idpFetch).mock.calls[0][0].url;
      expect(calledUrl).toContain("/api/metrics/services");
    });

    it("IdP エラーをそのまま転送する", async () => {
      const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR" } });
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/services", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(500);
    });
  });

  describe("GET /suspicious-logins — 不審なログイン検知", () => {
    const mockSuspiciousLogins = [
      {
        user_id: "user-1",
        email: "user@example.com",
        name: "Test User",
        country_count: 3,
        countries: ["JP", "US", "DE"],
        login_count: 5,
      },
    ];

    it("セッションなしで 401 を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/suspicious-logins");
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("IdP にリクエストをプロキシする", async () => {
      const idpFetch = mockIdp(200, {
        data: mockSuspiciousLogins,
        meta: { hours: 24, min_countries: 2 },
      });
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/suspicious-logins", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json<{
        data: typeof mockSuspiciousLogins;
        meta: { hours: number; min_countries: number };
      }>();
      expect(body.data).toEqual(mockSuspiciousLogins);
      const calledUrl = vi.mocked(idpFetch).mock.calls[0][0].url;
      expect(calledUrl).toContain("/api/metrics/suspicious-logins");
    });

    it("hours クエリパラメータを IdP に転送する", async () => {
      const idpFetch = mockIdp(200, {
        data: mockSuspiciousLogins,
        meta: { hours: 48, min_countries: 2 },
      });
      const app = buildApp(idpFetch);
      await app.request("/api/metrics/suspicious-logins?hours=48", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.searchParams.get("hours")).toBe("48");
    });

    it("min_countries クエリパラメータを IdP に転送する", async () => {
      const idpFetch = mockIdp(200, {
        data: mockSuspiciousLogins,
        meta: { hours: 24, min_countries: 3 },
      });
      const app = buildApp(idpFetch);
      await app.request("/api/metrics/suspicious-logins?min_countries=3", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.searchParams.get("min_countries")).toBe("3");
    });

    it("hours と min_countries を同時に転送する", async () => {
      const idpFetch = mockIdp(200, {
        data: [],
        meta: { hours: 72, min_countries: 4 },
      });
      const app = buildApp(idpFetch);
      await app.request("/api/metrics/suspicious-logins?hours=72&min_countries=4", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.searchParams.get("hours")).toBe("72");
      expect(calledUrl.searchParams.get("min_countries")).toBe("4");
    });

    it("IdP エラーをそのまま転送する", async () => {
      const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR" } });
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/suspicious-logins", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(500);
    });

    it("不正なhours（abc）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/suspicious-logins?hours=abc", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("hours=0（範囲外）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/suspicious-logins?hours=0", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("hours=721（範囲外）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/suspicious-logins?hours=721", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("不正なmin_countries（abc）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/suspicious-logins?min_countries=abc", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("min_countries=0（範囲外）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/suspicious-logins?min_countries=0", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("min_countries=101（範囲外）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/suspicious-logins?min_countries=101", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });
  });

  describe("GET /user-registrations — 日別新規ユーザー登録数", () => {
    const mockRegistrations = [
      { date: "2024-01-01", count: 5 },
      { date: "2024-01-02", count: 8 },
    ];

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/user-registrations");
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPへプロキシして登録数データを返す", async () => {
      const idpFetch = mockIdp(200, { data: mockRegistrations, days: 30 });
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/user-registrations", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockRegistrations; days: number }>();
      expect(body.data).toHaveLength(2);
      expect(body.data[0].count).toBe(5);
      expect(idpFetch).toHaveBeenCalledOnce();
    });

    it("IdP への呼び出しURLに /api/metrics/user-registrations が含まれる", async () => {
      const idpFetch = mockIdp(200, { data: mockRegistrations, days: 30 });
      const app = buildApp(idpFetch);
      await app.request("/api/metrics/user-registrations", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      const calledUrl = vi.mocked(idpFetch).mock.calls[0][0].url;
      expect(calledUrl).toContain("/api/metrics/user-registrations");
    });

    it("daysクエリパラメータをIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: mockRegistrations, days: 7 });
      const app = buildApp(idpFetch);
      await app.request("/api/metrics/user-registrations?days=7", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.searchParams.get("days")).toBe("7");
    });

    it("不正なdays（abc）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/user-registrations?days=abc", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("days=0（範囲外）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/user-registrations?days=0", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("IdP が500を返した場合は500をプロキシする", async () => {
      const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR" } });
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/user-registrations", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(500);
    });
  });

  describe("GET /active-users — DAU/WAU/MAU アクティブユーザー数", () => {
    const mockActiveUsers = {
      dau: 42,
      wau: 150,
      mau: 500,
    };

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/active-users");
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPへプロキシしてアクティブユーザー統計を返す", async () => {
      const idpFetch = mockIdp(200, { data: mockActiveUsers });
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/active-users", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockActiveUsers }>();
      expect(body.data.dau).toBe(42);
      expect(body.data.wau).toBe(150);
      expect(body.data.mau).toBe(500);
    });

    it("IdP への呼び出しURLに /api/metrics/active-users が含まれ /daily を含まない", async () => {
      const idpFetch = mockIdp(200, { data: mockActiveUsers });
      const app = buildApp(idpFetch);
      await app.request("/api/metrics/active-users", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      const calledUrl = vi.mocked(idpFetch).mock.calls[0][0].url;
      expect(calledUrl).toContain("/api/metrics/active-users");
      expect(calledUrl).not.toContain("/daily");
    });

    it("IdP が500を返した場合は500をプロキシする", async () => {
      const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR" } });
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/active-users", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(500);
    });
  });

  describe("GET /active-users/daily — 日別アクティブユーザー数推移", () => {
    const mockDailyActiveUsers = [
      { date: "2024-01-01", count: 40 },
      { date: "2024-01-02", count: 55 },
    ];

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/active-users/daily");
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPへプロキシして日別データを返す", async () => {
      const idpFetch = mockIdp(200, { data: mockDailyActiveUsers, days: 30 });
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/active-users/daily", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockDailyActiveUsers; days: number }>();
      expect(body.data).toHaveLength(2);
      expect(body.data[0].count).toBe(40);
    });

    it("IdP への呼び出しURLに /api/metrics/active-users/daily が含まれる", async () => {
      const idpFetch = mockIdp(200, { data: mockDailyActiveUsers, days: 30 });
      const app = buildApp(idpFetch);
      await app.request("/api/metrics/active-users/daily", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      const calledUrl = vi.mocked(idpFetch).mock.calls[0][0].url;
      expect(calledUrl).toContain("/api/metrics/active-users/daily");
    });

    it("daysクエリパラメータをIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: mockDailyActiveUsers, days: 7 });
      const app = buildApp(idpFetch);
      await app.request("/api/metrics/active-users/daily?days=7", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.searchParams.get("days")).toBe("7");
    });

    it("不正なdays（abc）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/active-users/daily?days=abc", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("days=0（範囲外）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/active-users/daily?days=0", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("IdP が500を返した場合は500をプロキシする", async () => {
      const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR" } });
      const app = buildApp(idpFetch);
      const res = await app.request("/api/metrics/active-users/daily", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(500);
    });
  });
});
