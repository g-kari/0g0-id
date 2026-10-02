import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Hono } from "hono";
import type { AdminAuditLog, AuditLogStats, TokenPayload, User } from "@0g0-id/shared";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    verifyAccessToken: vi.fn(),
    isAccessTokenRevoked: vi.fn(),
    findActiveBffSession: vi.fn(),
    findUserById: vi.fn(),
    listAdminAuditLogs: vi.fn(),
    getAuditLogStats: vi.fn(),
  };
});

import {
  findActiveBffSession,
  findUserById,
  getAuditLogStats,
  isAccessTokenRevoked,
  listAdminAuditLogs,
  verifyAccessToken,
} from "@0g0-id/shared";
import { getAuditLogStats as queryAuditLogStats } from "../../../../../packages/shared/src/db/admin-audit-logs";
import auditLogsRoutes from "../admin-audit-logs";
import { INTERNAL_OPENAPI } from "./internal-spec";

const list = INTERNAL_OPENAPI.paths["/api/admin/audit-logs"].get;
const stats = INTERNAL_OPENAPI.paths["/api/admin/audit-logs/stats"].get;
const schemas = INTERNAL_OPENAPI.components.schemas;
const listMedia = list.responses["200"].content["application/json"];
const statsMedia = stats.responses["200"].content["application/json"];
const log: AdminAuditLog = { ...listMedia.example.data[0], status: "success" };
const statistics: AuditLogStats = statsMedia.example.data;
const token: TokenPayload = {
  iss: "https://id.example.test",
  sub: log.admin_user_id,
  aud: "https://id.example.test",
  exp: 2000000000,
  iat: 1900000000,
  jti: "synthetic-jti",
  kid: "synthetic-kid",
  email: "admin@example.test",
  role: "admin",
};
const user: User = {
  id: token.sub,
  google_sub: null,
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: token.email,
  email_verified: 1,
  name: "Synthetic admin",
  picture: null,
  phone: null,
  address: null,
  role: "admin",
  banned_at: null,
  created_at: log.created_at,
  updated_at: log.created_at,
};
const env = {
  DB: {} as D1Database,
  JWT_PUBLIC_KEY: "synthetic-public-key",
  IDP_ORIGIN: token.iss,
};

async function request(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const app = new Hono<{ Bindings: typeof env }>();
  app.route("/api/admin/audit-logs", auditLogsRoutes);
  return app.request(
    new Request(`${token.iss}${path}`, {
      headers: { Authorization: "Bearer synthetic-token", ...headers },
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
  vi.mocked(listAdminAuditLogs).mockResolvedValue({ logs: [log], total: 1 });
  vi.mocked(getAuditLogStats).mockResolvedValue(statistics);
});

describe("audit log OpenAPI contracts", () => {
  it("documents only the three HTTP filters and pagination with actual defaults and clamping", async () => {
    expect(list.security).toEqual([{ BearerAuth: [] }]);
    expect(list.tags).toEqual(["管理者 API"]);
    expect(list.parameters.map(({ name }) => name)).toEqual([
      "admin_user_id",
      "target_id",
      "action",
      "limit",
      "offset",
    ]);
    expect(
      list.parameters.every(({ in: location, required }) => location === "query" && !required),
    ).toBe(true);
    expect(list.parameters.find(({ name }) => name === "limit")?.schema).toEqual({
      type: "integer",
      minimum: 1,
      default: 50,
    });
    expect(list.parameters.find(({ name }) => name === "offset")?.schema).toEqual({
      type: "integer",
      minimum: 0,
      default: 0,
    });

    const defaultResponse = await request("/api/admin/audit-logs");
    expect(defaultResponse.status).toBe(200);
    expect(await defaultResponse.json()).toEqual(listMedia.example);
    const query = new URLSearchParams({
      admin_user_id: log.admin_user_id,
      target_id: log.target_id,
      action: log.action,
      limit: "101",
      offset: "10",
    });
    const response = await request(`/api/admin/audit-logs?${query.toString()}`);
    expect(response.status).toBe(200);
    expect(listAdminAuditLogs).toHaveBeenLastCalledWith(env.DB, 100, 10, {
      adminUserId: log.admin_user_id,
      targetId: log.target_id,
      action: log.action,
    });
    expect(await response.json()).toEqual({
      data: [log],
      pagination: { total: 1, limit: 100, offset: 10 },
    });
  });

  it("matches shared audit model fields, nullable JSON strings, status and pagination envelopes", async () => {
    expect(Object.keys(schemas.AdminAuditLog.properties).sort()).toEqual(Object.keys(log).sort());
    expect([...schemas.AdminAuditLog.required].sort()).toEqual(Object.keys(log).sort());
    expect(schemas.AdminAuditLog.properties.details.type).toEqual(["string", "null"]);
    expect(schemas.AdminAuditLog.properties.ip_address.type).toEqual(["string", "null"]);
    expect(schemas.AdminAuditLog.properties.status.enum).toEqual(["success", "failure"]);
    expect(schemas.AdminAuditLog.properties.created_at).not.toHaveProperty("format");
    expect(listMedia.schema.required).toEqual(["data", "pagination"]);
    expect(listMedia.schema.properties.data.items.$ref).toBe("#/components/schemas/AdminAuditLog");
    expect(listMedia.schema.properties.pagination.$ref).toBe(
      "#/components/schemas/AdminAuditLogPagination",
    );
    expect([...schemas.AdminAuditLogPagination.required].sort()).toEqual([
      "limit",
      "offset",
      "total",
    ]);
    vi.mocked(listAdminAuditLogs).mockResolvedValueOnce({
      logs: [{ ...log, details: null, ip_address: null, status: "failure" }],
      total: 1,
    });
    expect(await (await request("/api/admin/audit-logs")).json()).toEqual({
      data: [{ ...log, details: null, ip_address: null, status: "failure" }],
      pagination: listMedia.example.pagination,
    });
  });

  it("does not expose the shared DB helper's status filter through HTTP", async () => {
    const response = await request("/api/admin/audit-logs?status=failure");
    expect(response.status).toBe(200);
    expect(listAdminAuditLogs).toHaveBeenCalledWith(env.DB, 50, 0, {
      adminUserId: undefined,
      targetId: undefined,
      action: undefined,
    });
  });

  it("retains both documented envelopes for empty results", async () => {
    vi.mocked(listAdminAuditLogs).mockResolvedValueOnce({ logs: [], total: 0 });
    vi.mocked(getAuditLogStats).mockResolvedValueOnce({
      action_stats: [],
      admin_stats: [],
      daily_stats: [],
    });
    expect(await (await request("/api/admin/audit-logs")).json()).toEqual({
      data: [],
      pagination: { total: 0, limit: 50, offset: 0 },
    });
    expect(await (await request("/api/admin/audit-logs/stats")).json()).toEqual({
      data: { action_stats: [], admin_stats: [], daily_stats: [] },
      days: 30,
    });
  });

  it.each([
    ["limit", "0", "invalidLimit"],
    ["limit", "1.5", "invalidLimit"],
    ["offset", "-1", "invalidOffset"],
    ["offset", "1e2", "invalidOffset"],
    ["admin_user_id", "invalid", "invalidAdminUserId"],
    ["target_id", "", "invalidTargetId"],
    ["action", "User.ban", "invalidAction"],
  ] as const)("matches documented 400 for %s=%s", async (name, value, example) => {
    const response = await request(
      `/api/admin/audit-logs?${new URLSearchParams({ [name]: value }).toString()}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      list.responses["400"].content["application/json"].examples[example].value,
    );
    expect(listAdminAuditLogs).not.toHaveBeenCalled();
  });

  it.each(["admin_user_id", "target_id"])(
    "UUID schema for %s uses the route's case-insensitive shape",
    async (name) => {
      const value = "ABCDEF00-0000-0000-0000-000000000001";
      const pattern = list.parameters.find((parameter) => parameter.name === name)?.schema.pattern;
      expect(pattern).toBeDefined();
      expect(new RegExp(pattern ?? "").test(value)).toBe(true);
      expect(new RegExp(pattern ?? "").test("invalid")).toBe(false);
      expect((await request(`/api/admin/audit-logs?${name}=${value}`)).status).toBe(200);
    },
  );

  it("matches the stats envelope, all three shared aggregates and default days", async () => {
    expect(stats.security).toEqual(list.security);
    expect(stats.tags).toEqual(list.tags);
    expect(stats.parameters).toMatchObject([
      {
        name: "days",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 90, default: 30 },
      },
    ]);
    expect(statsMedia.schema.required).toEqual(["data", "days"]);
    expect(statsMedia.schema.properties.data.$ref).toBe("#/components/schemas/AdminAuditLogStats");
    expect([...schemas.AdminAuditLogStats.required].sort()).toEqual(Object.keys(statistics).sort());
    for (const field of ["action_stats", "admin_stats", "daily_stats"] as const) {
      expect([...schemas.AdminAuditLogStats.properties[field].items.required].sort()).toEqual(
        Object.keys(statistics[field][0]).sort(),
      );
    }
    expect(await (await request("/api/admin/audit-logs/stats")).json()).toEqual(statsMedia.example);
    expect(getAuditLogStats).toHaveBeenCalledWith(env.DB, 30);
  });

  it.each([1, 90])("accepts the documented stats boundary days=%i", async (days) => {
    const response = await request(`/api/admin/audit-logs/stats?days=${days}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: statistics, days });
    expect(getAuditLogStats).toHaveBeenCalledWith(env.DB, days);
  });

  it.each(["", "0", "91", "-1", "1.5", "1e1", "+1", "abc"])(
    "matches INVALID_REQUEST for days=%s",
    async (days) => {
      const response = await request(
        `/api/admin/audit-logs/stats?${new URLSearchParams({ days }).toString()}`,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        stats.responses["400"].content["application/json"].example,
      );
      expect(getAuditLogStats).not.toHaveBeenCalled();
    },
  );

  it("documents days as a daily-only window, consistent with the actual aggregate queries", async () => {
    const statements: Array<{ sql: string; bind: ReturnType<typeof vi.fn> }> = [];
    const db = {
      prepare(sql: string) {
        const statement = { sql, bind: vi.fn(), all: vi.fn().mockResolvedValue({ results: [] }) };
        statement.bind.mockReturnValue(statement);
        statements.push(statement);
        return statement;
      },
    } as unknown as D1Database;
    expect(await queryAuditLogStats(db, 7)).toEqual({
      action_stats: [],
      admin_stats: [],
      daily_stats: [],
    });
    expect(statements).toHaveLength(3);
    expect(statements[0].sql).not.toContain("WHERE");
    expect(statements[1].sql).not.toContain("WHERE");
    expect(statements[0].bind).not.toHaveBeenCalled();
    expect(statements[1].bind).not.toHaveBeenCalled();
    expect(statements[2].sql).toContain("WHERE created_at >= ?");
    expect(statements[2].bind).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    expect(schemas.AdminAuditLogStats.properties.action_stats.description).toContain("全期間");
    expect(schemas.AdminAuditLogStats.properties.admin_stats.description).toContain("全期間");
    expect(schemas.AdminAuditLogStats.properties.daily_stats.description).toContain("直近 days 日");
  });

  it.each([
    ["/api/admin/audit-logs", list],
    ["/api/admin/audit-logs/stats", stats],
  ] as const)("matches auth, admin and storage errors for %s", async (path, operation) => {
    expect(Object.keys(operation.responses)).toEqual(["200", "400", "401", "403", "500"]);
    const missingHeader = await request(path, { Authorization: "" });
    expect(missingHeader.status).toBe(401);
    expect(await missingHeader.json()).toEqual(
      operation.responses["401"].content["application/json"].example,
    );
    vi.mocked(verifyAccessToken).mockResolvedValueOnce({ ...token, role: "user" });
    const forbidden = await request(path);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual(
      operation.responses["403"].content["application/json"].example,
    );
    for (const account of [null, { ...user, banned_at: "2026-03-27 12:00:00" }]) {
      vi.mocked(findUserById).mockResolvedValueOnce(account);
      const response = await request(path);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: "UNAUTHORIZED", message: "Account suspended or not found" },
      });
    }
    vi.mocked(isAccessTokenRevoked).mockResolvedValueOnce(true);
    expect((await request(path)).status).toBe(401);
    vi.mocked(findActiveBffSession).mockResolvedValueOnce(null);
    expect((await request(path, { "X-BFF-Session-Id": "synthetic-session" })).status).toBe(401);
    vi.mocked(verifyAccessToken).mockResolvedValueOnce({ ...token, jti: "" });
    expect((await request(path)).status).toBe(401);
    vi.mocked(listAdminAuditLogs).mockRejectedValueOnce(new Error("synthetic database error"));
    vi.mocked(getAuditLogStats).mockRejectedValueOnce(new Error("synthetic database error"));
    const failure = await request(path);
    expect(failure.status).toBe(500);
    expect(await failure.json()).toEqual(
      operation.responses["500"].content["application/json"].example,
    );
  });
});
