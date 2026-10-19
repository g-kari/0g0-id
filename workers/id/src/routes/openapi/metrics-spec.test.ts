import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Hono } from "hono";
import { z } from "zod";
import type { BffAccessTokenPayload, User } from "@0g0-id/shared";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    verifyAccessToken: vi.fn(),
    isAccessTokenRevoked: vi.fn(),
    findActiveBffSession: vi.fn(),
    findUserById: vi.fn(),
    countUsers: vi.fn(),
    countAdminUsers: vi.fn(),
    countServices: vi.fn(),
    countActiveRefreshTokens: vi.fn(),
    countRecentLoginEvents: vi.fn(),
    getLoginEventProviderStats: vi.fn(),
    getLoginEventCountryStats: vi.fn(),
    getDailyLoginTrends: vi.fn(),
    getServiceTokenStats: vi.fn(),
    getSuspiciousMultiCountryLogins: vi.fn(),
    getDailyUserRegistrations: vi.fn(),
    getActiveUserStats: vi.fn(),
    getDailyActiveUsers: vi.fn(),
    getLoginEventIpStats: vi.fn(),
    getLoginEventUserAgentStats: vi.fn(),
    getRecentLoginEvents: vi.fn(),
    getBffSessionDbscStats: vi.fn(),
  };
});

import {
  verifyAccessToken,
  isAccessTokenRevoked,
  findActiveBffSession,
  findUserById,
  encodeSession,
  parseDays,
  countUsers,
  countAdminUsers,
  countServices,
  countActiveRefreshTokens,
  countRecentLoginEvents,
  getLoginEventProviderStats,
  getLoginEventCountryStats,
  getDailyLoginTrends,
  getServiceTokenStats,
  getSuspiciousMultiCountryLogins,
  getDailyUserRegistrations,
  getActiveUserStats,
  getDailyActiveUsers,
  getLoginEventIpStats,
  getLoginEventUserAgentStats,
} from "@0g0-id/shared";
import metricsRoutes from "../metrics";
import adminMetricsRoutes from "../../../../admin/src/routes/metrics";
import adminSecurityRoutes from "../../../../admin/src/routes/security-trends";
import { INTERNAL_OPENAPI } from "./internal-spec";

const token: BffAccessTokenPayload = {
  iss: "https://id.example.test",
  sub: "synthetic-admin",
  aud: "https://id.example.test",
  exp: 2000000000,
  iat: 1900000000,
  jti: "synthetic-jti",
  kid: "synthetic-kid",
  email: "admin@example.test",
  role: "admin",
};
const env = { DB: {} as D1Database, JWT_PUBLIC_KEY: "synthetic-public-key", IDP_ORIGIN: token.iss };
const user = { id: token.sub, role: "admin", banned_at: null } as User;
const daily = [{ date: "2026-10-18", count: 3 }];
const fixtures = {
  "/api/metrics": {
    data: {
      total_users: 5,
      admin_users: 1,
      banned_users: 2,
      total_services: 3,
      active_sessions: 4,
      recent_logins_24h: 6,
      recent_logins_7d: 6,
      login_provider_stats_7d: [{ provider: "google", count: 6 }],
      login_country_stats_7d: [{ country: "unknown", count: 6 }],
    },
  },
  "/api/metrics/login-trends": { data: daily, days: 30 },
  "/api/metrics/services": {
    data: [
      {
        service_id: "synthetic-service",
        service_name: "Synthetic service",
        authorized_user_count: 2,
        active_token_count: 3,
      },
    ],
  },
  "/api/metrics/suspicious-logins": {
    data: [{ user_id: "synthetic-user", country_count: 2, countries: "JP,unknown" }],
    meta: { hours: 24, min_countries: 2 },
  },
  "/api/metrics/user-registrations": { data: daily, days: 30 },
  "/api/metrics/active-users": { data: { dau: 1, wau: 2, mau: 3 } },
  "/api/metrics/active-users/daily": { data: daily, days: 30 },
  "/api/metrics/ip-stats": {
    data: [{ ip_address: "192.0.2.1", count: 3, last_seen: "2026-10-18 12:00:00" }],
    meta: { days: 7, limit: 20 },
  },
  "/api/metrics/user-agent-stats": {
    data: [{ user_agent: "Synthetic browser", count: 3 }],
    meta: { days: 7, limit: 20 },
  },
};
type DocumentedPath = keyof typeof fixtures;
type Media = { schema: Parameters<typeof z.fromJSONSchema>[0] };
type Operation = {
  security: unknown;
  parameters: Array<{ name: string; schema: Record<string, unknown> }>;
  responses: Record<string, { content?: Record<string, Media> }>;
};
function operation(path: DocumentedPath): Operation {
  return (INTERNAL_OPENAPI.paths as unknown as Record<string, { get: Operation }>)[path].get;
}
function schema(path: DocumentedPath, status = "200"): z.ZodType {
  return z.fromJSONSchema(operation(path).responses[status].content!["application/json"].schema);
}
async function request(
  path: string,
  authorization: string | null = "Bearer synthetic-token",
): Promise<Response> {
  const app = new Hono<{ Bindings: typeof env }>();
  app.route("/api/metrics", metricsRoutes);
  return app.request(
    new Request(`${token.iss}${path}`, {
      headers: authorization === null ? {} : { Authorization: authorization },
    }),
    undefined,
    env,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(verifyAccessToken).mockResolvedValue(token);
  vi.mocked(isAccessTokenRevoked).mockResolvedValue(false);
  vi.mocked(findUserById).mockResolvedValue(user);
  vi.mocked(findActiveBffSession).mockResolvedValue({ user_id: token.sub } as Awaited<
    ReturnType<typeof findActiveBffSession>
  >);
  vi.mocked(countUsers).mockImplementation(async (_db, filter) => (filter?.banned ? 2 : 5));
  vi.mocked(countAdminUsers).mockResolvedValue(1);
  vi.mocked(countServices).mockResolvedValue(3);
  vi.mocked(countActiveRefreshTokens).mockResolvedValue(4);
  vi.mocked(countRecentLoginEvents).mockResolvedValue(6);
  vi.mocked(getLoginEventProviderStats).mockResolvedValue(
    fixtures["/api/metrics"].data.login_provider_stats_7d,
  );
  vi.mocked(getLoginEventCountryStats).mockResolvedValue(
    fixtures["/api/metrics"].data.login_country_stats_7d,
  );
  vi.mocked(getDailyLoginTrends).mockResolvedValue(daily);
  vi.mocked(getServiceTokenStats).mockResolvedValue(fixtures["/api/metrics/services"].data);
  vi.mocked(getSuspiciousMultiCountryLogins).mockResolvedValue(
    fixtures["/api/metrics/suspicious-logins"].data,
  );
  vi.mocked(getDailyUserRegistrations).mockResolvedValue(daily);
  vi.mocked(getActiveUserStats).mockResolvedValue(fixtures["/api/metrics/active-users"].data);
  vi.mocked(getDailyActiveUsers).mockResolvedValue(daily);
  vi.mocked(getLoginEventIpStats).mockResolvedValue(fixtures["/api/metrics/ip-stats"].data);
  vi.mocked(getLoginEventUserAgentStats).mockResolvedValue(
    fixtures["/api/metrics/user-agent-stats"].data,
  );
});

describe("documented metrics contracts with real query parsing", () => {
  it("keeps the shared parseDays implementation rather than a mocked clamp", () => {
    expect(vi.isMockFunction(parseDays)).toBe(false);
    expect(parseDays("200", { maxDays: 365 })).toEqual({ days: 200 });
    expect(parseDays("0")).toHaveProperty("error.code", "INVALID_REQUEST");
  });

  it.each(Object.keys(fixtures) as DocumentedPath[])(
    "matches the actual successful handler and schema: %s",
    async (path) => {
      const response = await request(path);
      const body: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(body).toEqual(fixtures[path]);
      expect(schema(path).safeParse(body).success).toBe(true);
      expect(operation(path).security).toEqual([{ BearerAuth: [] }]);
      expect(schema(path).safeParse({}).success).toBe(false);
    },
  );

  it.each([
    ["/api/metrics/login-trends", 365],
    ["/api/metrics/user-registrations", 365],
    ["/api/metrics/active-users/daily", 90],
  ] as const)("uses the real strict days range for %s", async (path, maximum) => {
    expect(operation(path).parameters.find(({ name }) => name === "days")?.schema).toEqual({
      type: "integer",
      minimum: 1,
      maximum,
      default: 30,
    });
    for (const value of ["0", String(maximum + 1), "abc", "1.5", "+1", ""]) {
      const response = await request(`${path}?days=${encodeURIComponent(value)}`);
      const body: unknown = await response.json();
      expect(response.status).toBe(400);
      expect(body).toEqual({
        error: {
          code: "INVALID_REQUEST",
          message: `days must be an integer between 1 and ${maximum}`,
        },
      });
      expect(schema(path, "400").safeParse(body).success).toBe(true);
    }
    for (const value of ["01", "90", String(maximum)]) {
      const response = await request(`${path}?days=${value}`);
      const body: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(body).toHaveProperty("days", Number(value));
      expect(schema(path).safeParse(body).success).toBe(true);
    }
  });

  it.each([
    [undefined, undefined, 24, 2],
    ["abc", "", 24, 2],
    ["0", "1", 1, 2],
    ["720", "100", 168, 10],
    ["12hours", "3.9", 12, 3],
    ["-4", "-1", 1, 2],
  ])(
    "documents parseInt fallback/clamping without inventing a 400: %s %s",
    async (hours, countries, appliedHours, appliedCountries) => {
      const query = new URLSearchParams();
      if (hours !== undefined) query.set("hours", String(hours));
      if (countries !== undefined) query.set("min_countries", String(countries));
      const response = await request(`/api/metrics/suspicious-logins?${query.toString()}`);
      const body: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(body).toHaveProperty("meta", { hours: appliedHours, min_countries: appliedCountries });
      expect(schema("/api/metrics/suspicious-logins").safeParse(body).success).toBe(true);
      expect(operation("/api/metrics/suspicious-logins").responses).not.toHaveProperty("400");
    },
  );

  it.each(["/api/metrics/ip-stats", "/api/metrics/user-agent-stats"] as const)(
    "keeps strict grouped-stat defaults and bounds: %s",
    async (path) => {
      for (const query of [
        "days=0",
        "days=366",
        "days=abc",
        "days=",
        "days=1.5",
        "limit=0",
        "limit=101",
        "limit=-1",
        "limit=",
        "limit=1.5",
      ]) {
        const response = await request(`${path}?${query.toString()}`);
        const body: unknown = await response.json();
        expect(response.status).toBe(400);
        expect(body).toHaveProperty("error.code", "INVALID_PARAMETER");
        expect(schema(path, "400").safeParse(body).success).toBe(true);
      }
      const response = await request(`${path}?days=365&limit=100`);
      const body: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(body).toHaveProperty("meta", { days: 365, limit: 100 });
      expect(schema(path).safeParse(body).success).toBe(true);
    },
  );

  it.each(Object.keys(fixtures) as DocumentedPath[])(
    "preserves authentication order and documents handler failures: %s",
    async (path) => {
      const missing = await request(`${path}?days=invalid`, null);
      expect(missing.status).toBe(401);
      vi.mocked(verifyAccessToken).mockResolvedValue({ ...token, role: "user" });
      const forbidden = await request(path);
      expect(forbidden.status).toBe(403);
      expect(operation(path).responses).toHaveProperty("401");
      expect(operation(path).responses).toHaveProperty("403");
      expect(operation(path).responses).toHaveProperty("500");
    },
  );

  it("rejects wrong response shape, missing required fields and invented nullable scalars", () => {
    expect(
      schema("/api/metrics/active-users/daily").safeParse({
        data: [{ date: "2026-10-18", active_users: 3 }],
        days: 30,
      }).success,
    ).toBe(false);
    expect(
      schema("/api/metrics/services").safeParse({
        data: [
          { service_id: "s", service_name: null, authorized_user_count: 1, active_token_count: 2 },
        ],
      }).success,
    ).toBe(false);
    expect(
      schema("/api/metrics/ip-stats").safeParse({
        data: [{ ip_address: null, count: 2, last_seen: "2026-10-18 12:00:00" }],
        meta: { days: 7, limit: 20 },
      }).success,
    ).toBe(false);
    expect(
      schema("/api/metrics/suspicious-logins").safeParse({
        data: [],
        meta: { hours: 169, min_countries: 2 },
      }).success,
    ).toBe(false);
    const root = { ...fixtures["/api/metrics"].data };
    for (const key of Object.keys(root)) {
      const copy: Record<string, unknown> = { ...root };
      delete copy[key];
      expect(schema("/api/metrics").safeParse({ data: copy }).success).toBe(false);
    }
  });

  it("matches the real 500 response without changing the handler", async () => {
    vi.mocked(getDailyLoginTrends).mockRejectedValue(new Error("synthetic DB failure"));
    const response = await request("/api/metrics/login-trends");
    const body: unknown = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    expect(schema("/api/metrics/login-trends", "500").safeParse(body).success).toBe(true);
  });
});

describe("existing BFF and IdP differences are preserved", () => {
  async function bff(
    path: string,
  ): Promise<{ response: Response; upstream: ReturnType<typeof vi.fn> }> {
    const cookie = await encodeSession(
      {
        session_id: "synthetic-session",
        access_token: "synthetic-token",
        refresh_token: "synthetic-refresh",
        user: { id: token.sub, email: token.email, name: "Synthetic admin", role: "admin" },
      },
      "synthetic-session-secret",
    );
    const upstream = vi.fn(async (req: Request) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).origin).toBe(token.iss);
      return request(new URL(req.url).pathname + new URL(req.url).search);
    });
    const app = new Hono();
    app.route("/api/metrics", adminMetricsRoutes);
    app.route("/api/security-trends", adminSecurityRoutes);
    const response = await app.request(
      new Request(`https://admin.example.test${path}`, {
        headers: { Cookie: `__Host-admin-session=${cookie}` },
      }),
      undefined,
      {
        IDP_ORIGIN: token.iss,
        SESSION_SECRET: "synthetic-session-secret",
        IDP: { fetch: upstream },
      },
    );
    return { response, upstream };
  }

  it.each(["login-trends", "user-registrations"])(
    "keeps BFF90 versus IdP365 for %s",
    async (suffix) => {
      const direct = await request(`/api/metrics/${suffix}?days=200`);
      expect(direct.status).toBe(200);
      const { response, upstream } = await bff(`/api/metrics/${suffix}?days=200`);
      expect(response.status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
      expect(await response.json()).toEqual({
        error: {
          code: "INVALID_PARAMETER",
          message: { code: "INVALID_REQUEST", message: "days must be an integer between 1 and 90" },
        },
      });
    },
  );

  it("keeps BFF validation and IdP effective suspicious-login limits distinct", async () => {
    const { response, upstream } = await bff(
      "/api/metrics/suspicious-logins?hours=720&min_countries=1",
    );
    expect(upstream).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("meta", { hours: 168, min_countries: 2 });
    const rejected = await bff("/api/metrics/suspicious-logins?hours=12hours");
    expect(rejected.response.status).toBe(400);
    expect(rejected.upstream).not.toHaveBeenCalled();
  });

  it.each(["ip-stats", "user-agent-stats"])(
    "records existing nested BFF days errors for %s",
    async (suffix) => {
      const { response, upstream } = await bff(`/api/security-trends/${suffix}?days=366`);
      expect(response.status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
      expect(await response.json()).toEqual({
        error: {
          code: "INVALID_PARAMETER",
          message: {
            code: "INVALID_REQUEST",
            message: "days must be an integer between 1 and 365",
          },
        },
      });
    },
  );
});
