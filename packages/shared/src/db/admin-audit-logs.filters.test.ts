import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { listAdminAuditLogs } from "./admin-audit-logs";
import type { AdminAuditLog } from "../types";

const adminId = "00000000-0000-0000-0000-000000000001";
const targetId = "00000000-0000-0000-0000-000000000002";
const otherId = "00000000-0000-0000-0000-000000000003";
const filters = { adminUserId: adminId, targetId, action: "user.ban" };

/** Run the real bound SELECTs against synthetic, disposable SQLite, never remote D1. */
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    "CREATE TABLE admin_audit_logs (id TEXT PRIMARY KEY, admin_user_id TEXT, action TEXT, target_type TEXT, target_id TEXT, details TEXT, ip_address TEXT, status TEXT, created_at TEXT)",
  );
  const statements: Array<{ sql: string; bind: ReturnType<typeof vi.fn> }> = [];
  const prepare = vi.fn((sql: string) => {
    let values: (string | number)[] = [];
    const stmt = {
      bind: vi.fn((...args: (string | number)[]) => {
        values = args;
        return stmt;
      }),
      all() {
        return Promise.resolve({ results: sqlite.prepare(sql).all(...values) });
      },
      first() {
        return Promise.resolve(sqlite.prepare(sql).get(...values) ?? null);
      },
    };
    statements.push({ sql, bind: stmt.bind });
    return stmt;
  });
  const insert = (id: string, overrides: Partial<AdminAuditLog> = {}) => {
    const row: AdminAuditLog = {
      id,
      admin_user_id: adminId,
      action: "user.ban",
      target_type: "user",
      target_id: targetId,
      details: null,
      ip_address: null,
      status: "success",
      created_at: "2026-10-02 01:00:00",
      ...overrides,
    };
    sqlite
      .prepare("INSERT INTO admin_audit_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        row.id,
        row.admin_user_id,
        row.action,
        row.target_type,
        row.target_id,
        row.details,
        row.ip_address,
        row.status,
        row.created_at,
      );
  };
  return { sqlite, insert, statements, db: { prepare } as unknown as D1Database };
}

describe("listAdminAuditLogs actual SQLite filter contracts", () => {
  it("ANDs all three filters for count and pages and orders 51 tied timestamps by descending ID", async () => {
    const f = fixture();
    try {
      // Deliberately insert out of order to prove SQL ordering, not insertion order.
      for (let i = 0; i < 51; i++) {
        const shuffled = (i * 19) % 51;
        f.insert(`match-${String(shuffled).padStart(3, "0")}`);
      }
      f.insert("other-admin", { admin_user_id: otherId });
      f.insert("other-target", { target_id: otherId });
      f.insert("other-action", { action: "user.unban" });

      const first = await listAdminAuditLogs(f.db, 50, 0, filters);
      const second = await listAdminAuditLogs(f.db, 50, 50, filters);
      const expectedIds = Array.from(
        { length: 51 },
        (_, i) => `match-${String(50 - i).padStart(3, "0")}`,
      );
      expect(first.total).toBe(51);
      expect(second.total).toBe(51);
      expect(first.logs.map((row) => row.id)).toEqual(expectedIds.slice(0, 50));
      expect(second.logs.map((row) => row.id)).toEqual(expectedIds.slice(50));
      expect(new Set([...first.logs, ...second.logs].map((row) => row.id)).size).toBe(51);
      for (const row of [...first.logs, ...second.logs]) {
        expect(row).toMatchObject({
          admin_user_id: adminId,
          target_id: targetId,
          action: "user.ban",
        });
      }

      const where = " WHERE admin_user_id = ? AND target_id = ? AND action = ?";
      expect(f.statements.map((stmt) => stmt.sql)).toEqual([
        `SELECT * FROM admin_audit_logs${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        `SELECT COUNT(*) as count FROM admin_audit_logs${where}`,
        `SELECT * FROM admin_audit_logs${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        `SELECT COUNT(*) as count FROM admin_audit_logs${where}`,
      ]);
      expect(f.statements[0].bind).toHaveBeenCalledWith(adminId, targetId, "user.ban", 50, 0);
      expect(f.statements[1].bind).toHaveBeenCalledWith(adminId, targetId, "user.ban");
      expect(f.statements[2].bind).toHaveBeenCalledWith(adminId, targetId, "user.ban", 50, 50);
      expect(f.statements[3].bind).toHaveBeenCalledWith(adminId, targetId, "user.ban");
    } finally {
      f.sqlite.close();
    }
  });

  it("counts every row with default filters and excludes each nonmatching dimension independently", async () => {
    const f = fixture();
    try {
      f.insert("match");
      f.insert("other-admin", { admin_user_id: otherId });
      f.insert("other-target", { target_id: otherId });
      f.insert("other-action", { action: "service.delete" });
      f.insert("failure", { status: "failure" });
      expect(await listAdminAuditLogs(f.db)).toMatchObject({ total: 5, logs: expect.any(Array) });
      expect(f.statements[0].sql).not.toContain("WHERE");
      expect(f.statements[1].sql).not.toContain("WHERE");
      expect(f.statements[0].bind).toHaveBeenCalledWith(50, 0);
      expect(f.statements[1].bind).toHaveBeenCalledWith();

      for (const filter of [{ adminUserId: adminId }, { targetId }, { action: "user.ban" }]) {
        const result = await listAdminAuditLogs(f.db, 50, 0, filter);
        expect(result.total).toBe(4);
        expect(result.logs).toHaveLength(4);
      }
      const combined = await listAdminAuditLogs(f.db, 50, 0, filters);
      expect(combined.total).toBe(2);
      expect(combined.logs.map((row) => row.status).sort()).toEqual(["failure", "success"]);
    } finally {
      f.sqlite.close();
    }
  });

  it("returns a genuine zero-count empty page when individually existing filters do not intersect", async () => {
    const f = fixture();
    try {
      f.insert("matches-admin", { target_id: otherId, action: "user.unban" });
      f.insert("matches-target", { admin_user_id: otherId, action: "user.unban" });
      f.insert("matches-action", { admin_user_id: otherId, target_id: otherId });
      expect(await listAdminAuditLogs(f.db, 50, 0, filters)).toEqual({ logs: [], total: 0 });
      expect(await listAdminAuditLogs(f.db, 50, 50, filters)).toEqual({ logs: [], total: 0 });
    } finally {
      f.sqlite.close();
    }
  });

  it("prioritizes creation time before ID and retains the filtered count beyond the last page", async () => {
    const f = fixture();
    try {
      f.insert("zzz-old", { created_at: "2026-10-01 23:59:59" });
      f.insert("aaa-new", { created_at: "2026-10-02 01:00:01" });
      f.insert("middle");
      expect((await listAdminAuditLogs(f.db, 50, 0, filters)).logs.map((row) => row.id)).toEqual([
        "aaa-new",
        "middle",
        "zzz-old",
      ]);
      expect(await listAdminAuditLogs(f.db, 50, 50, filters)).toEqual({ logs: [], total: 3 });
    } finally {
      f.sqlite.close();
    }
  });

  it.each(["adminUserId", "targetId", "action"])(
    "binds %s rather than interpolating SQL-like text",
    async (field) => {
      const f = fixture();
      try {
        f.insert("match");
        const payload = "synthetic' OR 1=1 --";
        expect(await listAdminAuditLogs(f.db, 50, 0, { ...filters, [field]: payload })).toEqual({
          logs: [],
          total: 0,
        });
        for (const stmt of f.statements) {
          expect(stmt.sql).not.toContain(payload);
          expect(stmt.bind).toHaveBeenCalledWith(
            ...Object.values({ ...filters, [field]: payload }),
            ...(stmt.sql.startsWith("SELECT *") ? [50, 0] : []),
          );
        }
      } finally {
        f.sqlite.close();
      }
    },
  );
});
