import { test, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { Hono } from "hono";
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    findUserById: vi.fn(),
    updateUserRoleWithRevocation: vi.fn(),
    banUserWithRevocation: vi.fn(),
    unbanUser: vi.fn(),
    revokeBffSessionByIdForUser: vi.fn(),
    revokeTokenByIdForUser: vi.fn(),
    revokeUserTokens: vi.fn(),
    deleteMcpSessionsByUser: vi.fn(),
    revokeAllBffSessionsByUserId: vi.fn(),
  };
});
import {
  findUserById,
  updateUserRoleWithRevocation,
  banUserWithRevocation,
  unbanUser,
  revokeBffSessionByIdForUser,
  revokeTokenByIdForUser,
  revokeUserTokens,
  deleteMcpSessionsByUser,
  revokeAllBffSessionsByUserId,
} from "@0g0-id/shared";
import type { IdpEnv, User } from "@0g0-id/shared";
import type { Variables } from "./_shared";
import authControl from "./admin-auth-control";
import sessions from "./admin-sessions";

const canary = "SYNTHETIC_ONLY_AUDIT_PRIVACY_CANARY";
const resourceId = "00000000-0000-4000-8000-000000000003";
const target = { id: "synthetic-target", role: "user", banned_at: null } as User;
const cases = [
  {
    name: "role",
    method: "PATCH",
    path: "/role",
    action: "user.role_change",
    mutation: updateUserRoleWithRevocation,
    details: { from: "user", to: "admin" },
    response: "Failed to change user role",
    success: { ...target, role: "admin" },
  },
  {
    name: "ban",
    method: "PATCH",
    path: "/ban",
    action: "user.ban",
    mutation: banUserWithRevocation,
    details: {},
    response: "Failed to ban user",
    success: { ...target, banned_at: "synthetic-time" },
  },
  {
    name: "unban",
    method: "DELETE",
    path: "/ban",
    action: "user.unban",
    mutation: unbanUser,
    details: {},
    response: null,
    success: target,
  },
  {
    name: "bff session",
    method: "DELETE",
    path: `/bff-sessions/${resourceId}`,
    action: "user.bff_session_revoked",
    mutation: revokeBffSessionByIdForUser,
    details: { sessionId: resourceId },
    response: null,
    success: 1,
  },
  {
    name: "token",
    method: "DELETE",
    path: `/tokens/${resourceId}`,
    action: "user.session_revoked",
    mutation: revokeTokenByIdForUser,
    details: { tokenId: resourceId },
    response: null,
    success: 1,
  },
  {
    name: "all sessions",
    method: "DELETE",
    path: "/tokens",
    action: "user.sessions_revoked",
    mutation: revokeUserTokens,
    details: {},
    response: null,
    success: undefined,
  },
];
const errors: [string, () => unknown][] = [
  ["Error", () => new Error(canary)],
  ["subclass", () => new TypeError(canary, { cause: canary })],
  ["string", () => canary],
  ["object", () => ({ message: canary, name: canary, stack: canary, cause: canary })],
  ["null", () => null],
  ["undefined", () => undefined],
  [
    "hostile Error getters",
    () => {
      const error = new Error();
      for (const property of ["message", "name", "stack", "cause"])
        Object.defineProperty(error, property, {
          get() {
            throw new Error("Getter touched");
          },
        });
      return error;
    },
  ],
  [
    "hostile coercion",
    () => ({
      toString() {
        throw new Error("Coercion touched");
      },
      [Symbol.toPrimitive]() {
        throw new Error("Coercion touched");
      },
    }),
  ],
];
const rows: { sql: string; values: unknown[] }[] = [];
let failAudit = false;
let observedError: unknown;
const run = vi.fn(async () => {
  if (failAudit) throw new Error("synthetic audit unavailable");
  return { success: true };
});
const db = {
  prepare(sql: string) {
    return {
      bind(...values: unknown[]) {
        return {
          async run() {
            const result = await run();
            rows.push({ sql, values });
            return result;
          },
        };
      },
    };
  },
} as unknown as D1Database;
const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();
// Exercise routes after an authenticated principal has been established; existing
// middleware tests retain responsibility for JWT/admin authorization coverage.
app.use("*", async (c, next) => {
  c.set("user", { sub: "synthetic-admin" } as Variables["user"]);
  await next();
});
app.onError((err, c) => {
  observedError = err;
  return c.json({ error: { code: "SYNTHETIC_HANDLER", message: "fixed" } }, 500);
});
app.route("/api/users", authControl);
app.route("/api/users", sessions);
const env = {
  DB: db,
  IDP_ORIGIN: "https://id.example.test",
  ADMIN_ORIGIN: "https://admin.example.test",
  USER_ORIGIN: "https://user.example.test",
} as IdpEnv;
const network = vi.fn(() => {
  throw new Error("Network forbidden");
});
function invoke(row: (typeof cases)[number], origin = env.ADMIN_ORIGIN) {
  return Promise.resolve(
    app.request(
      `https://id.example.test/api/users/synthetic-target${row.path}`,
      {
        method: row.method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "CF-Connecting-IP": "192.0.2.1",
        },
        ...(row.name === "role" ? { body: JSON.stringify({ role: "admin" }) } : {}),
      },
      env,
    ),
  ).catch((error: unknown) => {
    observedError = error;
    return new Response("synthetic uncaught boundary", { status: 500 });
  });
}
function setup(row: (typeof cases)[number]) {
  vi.mocked(findUserById).mockResolvedValue(
    row.name === "unban" ? { ...target, banned_at: "synthetic-time" } : target,
  );
}
beforeEach(() => {
  rows.length = 0;
  failAudit = false;
  observedError = undefined;
  vi.resetAllMocks();
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
for (const row of cases) {
  for (const [label, createError] of errors) {
    test(`${row.name}: ${label} cannot enter new audit INSERT`, async () => {
      setup(row);
      const error = createError();
      vi.mocked(row.mutation).mockRejectedValue(error);
      const response = await invoke(row);
      expect(response.status).toBe(500);
      expect(row.mutation).toHaveBeenCalledTimes(1);
      if (row.response)
        expect(await response.json()).toEqual({
          error: { code: "INTERNAL_ERROR", message: row.response },
        });
      // Hono handles Error instances; primitive throws can propagate instead. The
      // fixed handler is only a fixture boundary, never a product change.
      if (!row.response) expect(observedError).toBe(error);
      expect(rows).toHaveLength(1);
      expect(rows[0].sql).toBe(
        "INSERT INTO admin_audit_logs (id, admin_user_id, action, target_type, target_id, details, ip_address, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      expect(rows[0].values.slice(1)).toEqual([
        "synthetic-admin",
        row.action,
        "user",
        "synthetic-target",
        JSON.stringify({ ...row.details, error: "Unknown error" }),
        "192.0.2.1",
        "failure",
      ]);
      expect(JSON.stringify(rows)).not.toContain(canary);
    });
  }
  test(`${row.name}: success audit metadata unchanged`, async () => {
    setup(row);
    vi.mocked(row.mutation).mockResolvedValue(row.success as never);
    const response = await invoke(row);
    expect(response.status).toBe(["role", "ban", "unban"].includes(row.name) ? 200 : 204);
    expect(rows).toHaveLength(1);
    expect(rows[0].values.slice(1)).toEqual([
      "synthetic-admin",
      row.action,
      "user",
      "synthetic-target",
      Object.keys(row.details).length ? JSON.stringify(row.details) : null,
      "192.0.2.1",
      "success",
    ]);
    if (row.name === "all sessions") {
      expect(deleteMcpSessionsByUser).toHaveBeenCalledTimes(1);
      expect(revokeAllBffSessionsByUserId).toHaveBeenCalledTimes(1);
    }
  });
  test(`${row.name}: audit write failure preserves operation failure`, async () => {
    setup(row);
    failAudit = true;
    const error = new Error(canary);
    vi.mocked(row.mutation).mockRejectedValue(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await invoke(row);
      expect(response.status).toBe(500);
      if (row.response)
        expect(await response.json()).toEqual({
          error: { code: "INTERNAL_ERROR", message: row.response },
        });
      else expect(observedError).toBe(error);
      expect(run).toHaveBeenCalledTimes(1);
      expect(rows).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
  });
  test(`${row.name}: audit write failure preserves operation success`, async () => {
    setup(row);
    failAudit = true;
    vi.mocked(row.mutation).mockResolvedValue(row.success as never);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await invoke(row);
      expect(response.status).toBe(["role", "ban", "unban"].includes(row.name) ? 200 : 204);
      expect(observedError).toBeUndefined();
      expect(run).toHaveBeenCalledTimes(1);
      expect(rows).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
  });
  test(`${row.name}: invalid Origin prevents mutation and audit`, async () => {
    setup(row);
    const response = await invoke(row, "https://untrusted.example.test");
    expect(response.status).toBe(403);
    expect(row.mutation).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
}
