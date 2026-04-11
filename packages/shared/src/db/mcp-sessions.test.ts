import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import {
  createMcpSession,
  validateAndRefreshMcpSession,
  deleteMcpSession,
  deleteMcpSessionsByUser,
  cleanupExpiredMcpSessions,
} from "./mcp-sessions";
import { makeD1Mock } from "./test-helpers";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30分（mcp-sessions.ts と一致）

describe("createMcpSession", () => {
  it("正しい SQL と 4 つのパラメーターで INSERT を実行する", async () => {
    const db = makeD1Mock(null);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    await createMcpSession(db, "session-abc", "user-123");

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO mcp_sessions"));
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("session-abc", now, now, "user-123");
    expect(stmt.run).toHaveBeenCalled();
  });

  it("void を返す（戻り値なし）", async () => {
    const db = makeD1Mock(null);
    const result = await createMcpSession(db, "session-xyz", "user-456");
    expect(result).toBeUndefined();
  });

  it("created_at と last_active_at に同じタイムスタンプを設定する", async () => {
    const now = 1700000000000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const db = makeD1Mock(null);

    await createMcpSession(db, "session-ts", "user-789");

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    const [, createdAt, lastActiveAt] = stmt.bind.mock.calls[0] as [string, number, number, string];
    expect(createdAt).toBe(now);
    expect(lastActiveAt).toBe(now);
  });
});

describe("validateAndRefreshMcpSession", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("セッションが有効（last_active_at が cutoff より新しい）場合 true を返す", async () => {
    const db = makeD1Mock({ id: "session-valid" });
    const result = await validateAndRefreshMcpSession(db, "session-valid");
    expect(result).toBe(true);
  });

  it("セッションが期限切れ（first が null）の場合 false を返す", async () => {
    const db = makeD1Mock(null);
    const result = await validateAndRefreshMcpSession(db, "session-expired");
    expect(result).toBe(false);
  });

  it("セッションが存在しない場合 false を返す", async () => {
    const db = makeD1Mock(null);
    const result = await validateAndRefreshMcpSession(db, "session-not-found");
    expect(result).toBe(false);
  });

  it("UPDATE ... RETURNING id の SQL を使う", async () => {
    const db = makeD1Mock({ id: "session-abc" });
    await validateAndRefreshMcpSession(db, "session-abc");

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE mcp_sessions"));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("RETURNING id"));
  });

  it("last_active_at を更新するパラメーターを正しくバインドする", async () => {
    const now = 1700000000000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const db = makeD1Mock({ id: "session-abc" });

    await validateAndRefreshMcpSession(db, "session-abc");

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    const [newLastActiveAt, sessionId, cutoff] = stmt.bind.mock.calls[0] as [
      number,
      string,
      number,
    ];
    expect(newLastActiveAt).toBe(now);
    expect(sessionId).toBe("session-abc");
    expect(cutoff).toBe(now - SESSION_TTL_MS);
  });
});

describe("deleteMcpSession", () => {
  it("正しい sessionId で DELETE を実行する", async () => {
    const db = makeD1Mock(null);
    await deleteMcpSession(db, "session-del");

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM mcp_sessions"));
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("session-del");
    expect(stmt.run).toHaveBeenCalled();
  });

  it("void を返す（戻り値なし）", async () => {
    const db = makeD1Mock(null);
    const result = await deleteMcpSession(db, "session-xyz");
    expect(result).toBeUndefined();
  });

  it("WHERE id = ? 条件で絞り込む", async () => {
    const db = makeD1Mock(null);
    await deleteMcpSession(db, "session-abc");

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("WHERE id = ?"));
  });
});

describe("deleteMcpSessionsByUser", () => {
  it("正しい userId で DELETE を実行する", async () => {
    const db = makeD1Mock(null);
    await deleteMcpSessionsByUser(db, "user-123");

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM mcp_sessions"));
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.bind).toHaveBeenCalledWith("user-123");
    expect(stmt.run).toHaveBeenCalled();
  });

  it("void を返す（戻り値なし）", async () => {
    const db = makeD1Mock(null);
    const result = await deleteMcpSessionsByUser(db, "user-456");
    expect(result).toBeUndefined();
  });

  it("WHERE user_id = ? 条件で絞り込む", async () => {
    const db = makeD1Mock(null);
    await deleteMcpSessionsByUser(db, "user-789");

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("WHERE user_id = ?"));
  });
});

describe("cleanupExpiredMcpSessions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("期限切れセッションを削除する DELETE を実行する", async () => {
    const db = makeD1Mock(null);
    await cleanupExpiredMcpSessions(db);

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM mcp_sessions"));
    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(stmt.run).toHaveBeenCalled();
  });

  it("last_active_at <= cutoff の条件を使う", async () => {
    const db = makeD1Mock(null);
    await cleanupExpiredMcpSessions(db);

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("last_active_at <="));
  });

  it("cutoff に SESSION_TTL_MS を引いたタイムスタンプをバインドする", async () => {
    const now = 1700000000000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const db = makeD1Mock(null);

    await cleanupExpiredMcpSessions(db);

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0].value;
    const [cutoff] = stmt.bind.mock.calls[0] as [number];
    expect(cutoff).toBe(now - SESSION_TTL_MS);
  });

  it("void を返す（戻り値なし）", async () => {
    const db = makeD1Mock(null);
    const result = await cleanupExpiredMcpSessions(db);
    expect(result).toBeUndefined();
  });
});
