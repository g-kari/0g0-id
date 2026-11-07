import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Hono } from "hono";
import type { Context } from "hono";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    findUserById: vi.fn(),
    updateUserRoleWithRevocation: vi.fn(),
    // Keep the real audit SQL builder, helper, and console logger.
  };
});

import { findUserById, updateUserRoleWithRevocation } from "@0g0-id/shared";
import type { IdpEnv, TokenPayload, User } from "@0g0-id/shared";
import { logAdminAudit } from "./audit";
import type { AuditLogInput } from "./audit";
import authControl from "../routes/users/admin-auth-control";
import type { Variables } from "../routes/users/_shared";

type AuditEnv = { Bindings: IdpEnv; Variables: { user: TokenPayload } };
const canary = "SYNTHETIC_ONLY_AUDIT_FALLBACK_CANARY";
const adminId = "synthetic-admin-identifier";
const targetId = "synthetic-target-identifier";
const target = {
  id: targetId,
  role: "user",
  banned_at: null,
} as User;
const touched: string[] = [];
const failures: [string, () => unknown][] = [
  ["Error", () => new Error(canary)],
  ["enumerable Error data", () => Object.assign(new Error(canary), { email: canary })],
  ["string", () => canary],
  ["object", () => ({ message: canary, stack: canary, cause: canary, email: canary })],
  ["null", () => null],
  ["undefined", () => undefined],
  ["bigint", () => 1n],
  [
    "circular",
    () => {
      const error: { self?: unknown; email: string } = { email: canary };
      error.self = error;
      return error;
    },
  ],
  [
    "throwing enumerable getter",
    () =>
      Object.defineProperty({}, "email", {
        enumerable: true,
        get() {
          touched.push("email");
          throw new Error(canary);
        },
      }),
  ],
  [
    "throwing toJSON",
    () => ({
      toJSON() {
        touched.push("toJSON");
        throw new Error(canary);
      },
    }),
  ],
  [
    "toJSON returning private data",
    () => ({
      toJSON() {
        touched.push("toJSON");
        return { email: canary };
      },
    }),
  ],
  [
    "hostile Error properties",
    () => {
      const error = new Error();
      for (const name of ["message", "name", "stack", "cause"]) {
        Object.defineProperty(error, name, {
          enumerable: true,
          get() {
            touched.push(name);
            throw new Error(canary);
          },
        });
      }
      return error;
    },
  ],
  [
    "hostile proxy",
    () =>
      new Proxy(
        {},
        {
          get() {
            touched.push("proxy get");
            throw new Error(canary);
          },
          ownKeys() {
            touched.push("proxy ownKeys");
            throw new Error(canary);
          },
        },
      ),
  ],
];
const bound: { sql: string; values: unknown[] }[] = [];
let rejectAudit = false;
let auditError: unknown;
const run = vi.fn(async () => {
  if (rejectAudit) throw auditError;
  return { success: true };
});
const db = {
  prepare(sql: string) {
    return {
      bind(...values: unknown[]) {
        bound.push({ sql, values });
        return { run };
      },
    };
  },
} as unknown as D1Database;
const env = {
  DB: db,
  IDP_ORIGIN: "https://id.example.test",
  ADMIN_ORIGIN: "https://admin.example.test",
  USER_ORIGIN: "https://user.example.test",
} as IdpEnv;
const input: AuditLogInput = {
  action: "user.role_change",
  targetType: "user",
  targetId,
  details: { from: "user", to: "admin" },
};
const contextFixture = {
  get: () => ({ sub: adminId }),
  req: {
    raw: new Request("https://id.example.test/synthetic", {
      headers: { "CF-Connecting-IP": "192.0.2.1" },
    }),
  },
  env,
};
const context = contextFixture as unknown as Context<AuditEnv>;
const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();
// This fixture starts after authenticated admin middleware, whose own tests
// retain responsibility for JWT/admin authorization behavior.
app.use("*", async (c, next) => {
  c.set("user", { sub: adminId } as TokenPayload);
  await next();
});
app.route("/api/users", authControl);
const network = vi.fn(() => {
  throw new Error("Network forbidden in synthetic audit tests");
});
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

function expectFixedFallback(): void {
  expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ level: "error", ctx: "audit", msg: "Failed to create admin audit log" }),
  );
  expect(warnSpy).not.toHaveBeenCalled();
  expect(logSpy).not.toHaveBeenCalled();
  expect(touched).toEqual([]);
}

function invoke(origin = env.ADMIN_ORIGIN): Response | Promise<Response> {
  return app.request(
    `https://id.example.test/api/users/${targetId}/role`,
    {
      method: "PATCH",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "CF-Connecting-IP": "192.0.2.1",
      },
      body: JSON.stringify({ role: "admin" }),
    },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  bound.length = 0;
  touched.length = 0;
  rejectAudit = false;
  auditError = undefined;
  vi.mocked(findUserById).mockResolvedValue(target);
  vi.mocked(updateUserRoleWithRevocation).mockResolvedValue({ ...target, role: "admin" });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", network);
});

afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("audit write failure console privacy", () => {
  for (const [label, makeError] of failures) {
    it(`${label}: helper ignores exception and identifiers`, async () => {
      rejectAudit = true;
      auditError = makeError();
      await expect(logAdminAudit(context, input)).resolves.toBeUndefined();
      expect(run).toHaveBeenCalledTimes(1);
      expectFixedFallback();
    });

    for (const operationFails of [false, true]) {
      it(`${label}: failed audit preserves role-change ${operationFails ? "failure" : "success"}`, async () => {
        rejectAudit = true;
        auditError = makeError();
        if (operationFails)
          vi.mocked(updateUserRoleWithRevocation).mockRejectedValueOnce(
            new Error("synthetic mutation failure"),
          );
        const response = await invoke();
        expect(response.status).toBe(operationFails ? 500 : 200);
        if (operationFails)
          expect(await response.json()).toEqual({
            error: { code: "INTERNAL_ERROR", message: "Failed to change user role" },
          });
        else expect(await response.json()).toHaveProperty("data.role", "admin");
        expect(updateUserRoleWithRevocation).toHaveBeenCalledExactlyOnceWith(db, targetId, "admin");
        expect(run).toHaveBeenCalledTimes(1);
        expectFixedFallback();
      });
    }
  }

  it("does not log unvalidated runtime action/target/status fields", async () => {
    rejectAudit = true;
    auditError = new Error("synthetic D1 failure");
    const untyped = {
      action: canary,
      targetType: canary,
      targetId: canary,
      status: canary,
      details: { email: canary },
    } as unknown as AuditLogInput;
    await expect(logAdminAudit(context, untyped)).resolves.toBeUndefined();
    expectFixedFallback();
  });

  it("does not reread input after an audit argument getter fails", async () => {
    let reads = 0;
    const untyped = Object.defineProperty({ ...input }, "action", {
      get() {
        reads++;
        throw new Error(canary);
      },
    });
    await expect(logAdminAudit(context, untyped)).resolves.toBeUndefined();
    expect(reads).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expectFixedFallback();
  });
});

describe("audit behavior controls", () => {
  it("preserves successful SQL, all eight binds, and audit details", async () => {
    await logAdminAudit(context, { ...input, status: "failure" });
    expect(bound).toHaveLength(1);
    expect(bound[0].sql).toBe(
      "INSERT INTO admin_audit_logs (id, admin_user_id, action, target_type, target_id, details, ip_address, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    expect(bound[0].values).toEqual([
      expect.any(String),
      adminId,
      "user.role_change",
      "user",
      targetId,
      JSON.stringify(input.details),
      "192.0.2.1",
      "failure",
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("preserves omitted details/IP/status defaults", async () => {
    const withoutIp = {
      ...contextFixture,
      req: { raw: new Request("https://id.example.test") },
    } as unknown as Context<AuditEnv>;
    await logAdminAudit(withoutIp, { action: "user.ban", targetType: "user", targetId });
    expect(bound[0].values.slice(5)).toEqual([null, null, "success"]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("invalid Origin still prevents mutation and audit", async () => {
    const response = await invoke("https://untrusted.example.test");
    expect(response.status).toBe(403);
    expect(updateUserRoleWithRevocation).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("missing authenticated context keeps its existing precondition failure", async () => {
    const invalid = {
      ...contextFixture,
      get: () => {
        throw new Error("Missing principal");
      },
    } as unknown as Context<AuditEnv>;
    await expect(logAdminAudit(invalid, input)).rejects.toThrow("Missing principal");
    expect(run).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
