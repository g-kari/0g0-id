import { describe, it, expect, vi } from "vite-plus/test";
import {
  createBffSession,
  findActiveBffSession,
  revokeBffSession,
  revokeBffSessionByIdForUser,
  revokeAllBffSessionsByUserId,
  cleanupStaleBffSessions,
  countActiveBffSessionsByUserId,
  bindDeviceKeyToBffSession,
  listActiveBffSessionsByUserId,
  getBffSessionDbscStats,
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

describe("revokeBffSessionByIdForUser", () => {
  it("失効した件数を返す（user_id 一致）", async () => {
    const db = makeD1Mock(null, [], 1);
    const count = await revokeBffSessionByIdForUser(db, "s-1", "user-1", "admin_action");
    expect(count).toBe(1);
  });

  it("user_id 不一致や存在しない場合は 0", async () => {
    const db = makeD1Mock(null, [], 0);
    const count = await revokeBffSessionByIdForUser(db, "s-1", "user-2", "admin_action");
    expect(count).toBe(0);
  });

  it("SQL に id・user_id・revoked_at IS NULL が含まれる", async () => {
    const db = makeD1Mock(null, [], 1);
    await revokeBffSessionByIdForUser(db, "s-1", "user-1", "admin_action");
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE bff_sessions");
    expect(sql).toContain("id = ?");
    expect(sql).toContain("user_id = ?");
    expect(sql).toContain("revoked_at IS NULL");
  });

  it("bind は now, reason, sessionId, userId の順", async () => {
    const db = makeD1Mock(null, [], 1);
    await revokeBffSessionByIdForUser(db, "s-1", "user-1", "admin_action");
    const bindCall = (db._stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bindCall[1]).toBe("admin_action");
    expect(bindCall[2]).toBe("s-1");
    expect(bindCall[3]).toBe("user-1");
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

describe("bindDeviceKeyToBffSession", () => {
  it("UPDATE で device_public_key_jwk と device_bound_at を設定する", async () => {
    const db = makeD1Mock(null, [], 1);
    const ok = await bindDeviceKeyToBffSession(db, "s-1", '{"kty":"EC"}');
    expect(ok).toBe(true);
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE bff_sessions");
    expect(sql).toContain("device_public_key_jwk = ?");
    expect(sql).toContain("device_bound_at = ?");
    // 二重バインド防止: device_public_key_jwk IS NULL 条件が含まれる
    expect(sql).toContain("device_public_key_jwk IS NULL");
    // 失効・期限切れセッションは更新対象外
    expect(sql).toContain("revoked_at IS NULL");
    expect(sql).toContain("expires_at >");
  });

  it("changes が 0 なら false を返す（既にバインド済み等）", async () => {
    const db = makeD1Mock(null, [], 0);
    const ok = await bindDeviceKeyToBffSession(db, "s-1", '{"kty":"EC"}');
    expect(ok).toBe(false);
  });
});

describe("listActiveBffSessionsByUserId", () => {
  it("アクティブセッションを created_at DESC で返す", async () => {
    const rows = [
      {
        id: "s-2",
        user_id: "user-1",
        created_at: 2000,
        expires_at: 9999999999,
        user_agent: "Chrome",
        ip: "203.0.113.2",
        bff_origin: "https://admin.0g0.xyz",
        device_public_key_jwk: '{"kty":"EC"}',
        device_bound_at: 2100,
      },
      {
        id: "s-1",
        user_id: "user-1",
        created_at: 1000,
        expires_at: 9999999999,
        user_agent: null,
        ip: null,
        bff_origin: "https://user.0g0.xyz",
        device_public_key_jwk: null,
        device_bound_at: null,
      },
    ];
    const db = makeD1Mock(null, rows);
    const sessions = await listActiveBffSessionsByUserId(db, "user-1");
    expect(sessions).toHaveLength(2);
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("FROM bff_sessions");
    expect(sql).toContain("revoked_at IS NULL");
    expect(sql).toContain("expires_at >");
    expect(sql).toContain("ORDER BY created_at DESC");
  });

  it("device_public_key_jwk は返さず has_device_key に畳む", async () => {
    const rows = [
      {
        id: "s-bound",
        user_id: "user-1",
        created_at: 1000,
        expires_at: 9999999999,
        user_agent: null,
        ip: null,
        bff_origin: "https://admin.0g0.xyz",
        device_public_key_jwk: '{"kty":"EC","crv":"P-256","x":"X","y":"Y"}',
        device_bound_at: 1500,
      },
      {
        id: "s-unbound",
        user_id: "user-1",
        created_at: 900,
        expires_at: 9999999999,
        user_agent: null,
        ip: null,
        bff_origin: "https://user.0g0.xyz",
        device_public_key_jwk: null,
        device_bound_at: null,
      },
    ];
    const db = makeD1Mock(null, rows);
    const sessions = await listActiveBffSessionsByUserId(db, "user-1");
    expect(sessions[0].has_device_key).toBe(true);
    expect(sessions[0].device_bound_at).toBe(1500);
    expect(sessions[1].has_device_key).toBe(false);
    expect(sessions[1].device_bound_at).toBeNull();
    // 公開鍵 JWK 生データをレスポンスに含めない
    expect(sessions[0]).not.toHaveProperty("device_public_key_jwk");
  });

  it("0件なら空配列", async () => {
    const db = makeD1Mock(null, []);
    const sessions = await listActiveBffSessionsByUserId(db, "user-1");
    expect(sessions).toEqual([]);
  });
});

describe("getBffSessionDbscStats", () => {
  it("BFF origin 別の集計から全体総数・バインド済み・未バインドを算出する", async () => {
    const rows = [
      { bff_origin: "https://admin.0g0.xyz", total: 10, device_bound: 10 },
      { bff_origin: "https://user.0g0.xyz", total: 100, device_bound: 80 },
    ];
    const db = makeD1Mock(null, rows);
    const stats = await getBffSessionDbscStats(db);
    expect(stats.total).toBe(110);
    expect(stats.device_bound).toBe(90);
    expect(stats.unbound).toBe(20);
    expect(stats.by_bff_origin).toEqual([
      { bff_origin: "https://admin.0g0.xyz", total: 10, device_bound: 10, unbound: 0 },
      { bff_origin: "https://user.0g0.xyz", total: 100, device_bound: 80, unbound: 20 },
    ]);
  });

  it("アクティブ条件（revoked_at IS NULL かつ expires_at > now）と GROUP BY bff_origin を SQL に含む", async () => {
    const db = makeD1Mock(null, []);
    await getBffSessionDbscStats(db);
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("FROM bff_sessions");
    expect(sql).toContain("revoked_at IS NULL");
    expect(sql).toContain("expires_at >");
    expect(sql).toContain("GROUP BY bff_origin");
    // 公開鍵 JWK そのものは SELECT 対象に含めない（件数のみ集計）
    expect(sql).not.toContain("device_public_key_jwk AS");
  });

  it("0件なら total=device_bound=unbound=0 と空の by_bff_origin を返す", async () => {
    const db = makeD1Mock(null, []);
    const stats = await getBffSessionDbscStats(db);
    expect(stats).toEqual({ total: 0, device_bound: 0, unbound: 0, by_bff_origin: [] });
  });

  it("D1 が文字列で数値を返しても Number 化される（SUM の型揺れ対策）", async () => {
    const rows = [
      {
        bff_origin: "https://user.0g0.xyz",
        total: "5" as unknown as number,
        device_bound: "3" as unknown as number,
      },
    ];
    const db = makeD1Mock(null, rows);
    const stats = await getBffSessionDbscStats(db);
    expect(stats.total).toBe(5);
    expect(stats.device_bound).toBe(3);
    expect(stats.unbound).toBe(2);
  });

  it("SUM が NULL（例: 行は 1 件だが device_public_key_jwk カウントが全部 NULL）でも 0 扱い", async () => {
    const rows = [
      { bff_origin: "https://user.0g0.xyz", total: 2, device_bound: null as unknown as number },
    ];
    const db = makeD1Mock(null, rows);
    const stats = await getBffSessionDbscStats(db);
    expect(stats.device_bound).toBe(0);
    expect(stats.unbound).toBe(2);
  });
});
