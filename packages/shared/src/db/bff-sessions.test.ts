import { describe, it, expect, vi } from "vite-plus/test";
import {
  createBffSession,
  findActiveBffSession,
  revokeBffSession,
  revokeAllBffSessionsByUserId,
  cleanupStaleBffSessions,
  countActiveBffSessionsByUserId,
} from "./bff-sessions";
import { makeD1Mock } from "./test-helpers";

describe("createBffSession", () => {
  it("INSERT INTO bff_sessions を実行する", async () => {
    const db = makeD1Mock();
    await createBffSession(db, {
      id: "00000000-0000-0000-0000-000000000001",
      userId: "user-1",
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      bffOrigin: "https://user.0g0.xyz",
      userAgent: "Mozilla/5.0",
      ip: "203.0.113.1",
    });
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO bff_sessions"));
    expect((db._stmt as unknown as { run: ReturnType<typeof vi.fn> }).run).toHaveBeenCalledOnce();
  });

  it("user_agent / ip が未指定でも null でバインドされる", async () => {
    const db = makeD1Mock();
    await createBffSession(db, {
      id: "00000000-0000-0000-0000-000000000002",
      userId: "user-1",
      expiresAt: 1234567890,
      bffOrigin: "https://admin.0g0.xyz",
    });
    const bindCalls = (db._stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bindCalls).toContain(null);
  });
});

describe("findActiveBffSession", () => {
  it("有効なセッションを返す", async () => {
    const row = {
      id: "s-1",
      user_id: "user-1",
      created_at: 1000,
      expires_at: 9999999999,
      revoked_at: null,
      revoked_reason: null,
      user_agent: null,
      ip: null,
      bff_origin: "https://user.0g0.xyz",
    };
    const db = makeD1Mock(row);
    const result = await findActiveBffSession(db, "s-1");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("s-1");
    // SQL には revoked_at IS NULL と expires_at > ? が含まれる
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("revoked_at IS NULL");
    expect(sql).toContain("expires_at >");
  });

  it("存在しない場合は null", async () => {
    const db = makeD1Mock(null);
    const result = await findActiveBffSession(db, "missing");
    expect(result).toBeNull();
  });
});

describe("revokeBffSession", () => {
  it("UPDATE ... revoked_at = ? を実行する", async () => {
    const db = makeD1Mock();
    await revokeBffSession(db, "s-1", "user_logout");
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE bff_sessions");
    expect(sql).toContain("revoked_at = ?");
    expect(sql).toContain("revoked_at IS NULL");
  });
});

describe("revokeAllBffSessionsByUserId", () => {
  it("changes 数を返す", async () => {
    const db = makeD1Mock(null, [], 3);
    const count = await revokeAllBffSessionsByUserId(db, "user-1", "security_event");
    expect(count).toBe(3);
  });
});

describe("cleanupStaleBffSessions", () => {
  it("DELETE ... WHERE expires_at < ? OR revoked_at < ? を実行する", async () => {
    const db = makeD1Mock();
    await cleanupStaleBffSessions(db);
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("DELETE FROM bff_sessions");
    expect(sql).toContain("expires_at <");
    expect(sql).toContain("revoked_at");
  });
});

describe("countActiveBffSessionsByUserId", () => {
  it("COUNT(*) を返す", async () => {
    const db = makeD1Mock({ cnt: 2 });
    const count = await countActiveBffSessionsByUserId(db, "user-1");
    expect(count).toBe(2);
  });

  it("行なしの場合は 0", async () => {
    const db = makeD1Mock(null);
    const count = await countActiveBffSessionsByUserId(db, "user-1");
    expect(count).toBe(0);
  });
});
