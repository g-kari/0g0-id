import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { getRecentLoginEvents } from "./login-events";

/** Execute the actual bound SQL against disposable in-memory SQLite, never remote D1. */
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    "CREATE TABLE login_events (id TEXT, user_id TEXT, provider TEXT, country TEXT, created_at TEXT)",
  );
  const prepare = vi.fn((sql: string) => {
    let values: (string | number)[] = [];
    const stmt = {
      bind(...args: (string | number)[]) {
        values = args;
        return stmt;
      },
      all() {
        return Promise.resolve({ results: sqlite.prepare(sql).all(...values) });
      },
      first() {
        return Promise.resolve(sqlite.prepare(sql).get(...values) ?? null);
      },
    };
    return stmt;
  });
  const insert = (
    id: string,
    user = "user-1",
    provider = "google",
    country: string | null = "JP",
    time = "2026-10-02 01:00:00",
  ) => {
    sqlite
      .prepare("INSERT INTO login_events VALUES (?, ?, ?, ?, ?)")
      .run(id, user, provider, country, time);
  };
  return { sqlite, insert, prepare, db: { prepare } as unknown as D1Database };
}

describe("getRecentLoginEvents bound filtering", () => {
  it("combines filters for both count and ordered pages, including the 51st row", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 51; i++) f.insert(`e${String(i).padStart(3, "0")}`);
      f.insert("other-user", "user-2");
      f.insert("other-country", "user-1", "google", "US");
      f.insert("other-provider", "user-1", "github");
      f.insert("old", "user-1", "google", "JP", "2026-09-01 01:00:00");
      f.insert("unknown", "user-1", "google", null);
      const filters = {
        userId: "user-1",
        country: "JP",
        provider: "google" as const,
        sinceIso: "2026-10-01T02:00:00.000Z",
      };
      const page1 = await getRecentLoginEvents(f.db, 50, 0, filters);
      const page2 = await getRecentLoginEvents(f.db, 50, 50, filters);
      expect(page1.total).toBe(51);
      expect(page2.total).toBe(51);
      expect(page1.events).toHaveLength(50);
      expect(page2.events.map((e) => e.id)).toEqual(["e000"]);
      expect(page1.events[0].id).toBe("e050");
      expect(await getRecentLoginEvents(f.db)).toMatchObject({ total: 56 });
      expect(await getRecentLoginEvents(f.db, 50, 0, { country: "unknown" })).toMatchObject({
        total: 1,
        events: [{ id: "unknown", country: null }],
      });
      expect(await getRecentLoginEvents(f.db, 50, 0, { userId: "missing" })).toEqual({
        total: 0,
        events: [],
      });
    } finally {
      f.sqlite.close();
    }
  });
  it("includes the exact UTC cutoff in both SQLite and ISO formats, excludes one millisecond before", async () => {
    const f = fixture();
    try {
      f.insert("at-sql", undefined, undefined, undefined, "2026-10-01 02:00:00.123");
      f.insert("at-iso", undefined, undefined, undefined, "2026-10-01T02:00:00.123Z");
      f.insert("before-sql", undefined, undefined, undefined, "2026-10-01 02:00:00.122");
      f.insert("before-iso", undefined, undefined, undefined, "2026-10-01T02:00:00.122Z");
      f.insert("after", undefined, undefined, undefined, "2026-10-01T02:00:00.124Z");
      const result = await getRecentLoginEvents(f.db, 50, 0, {
        sinceIso: "2026-10-01T02:00:00.123Z",
      });
      expect(result.total).toBe(3);
      expect(result.events.map((e) => e.id).sort()).toEqual(["after", "at-iso", "at-sql"]);
    } finally {
      f.sqlite.close();
    }
  });
  it("binds filter values instead of interpolating SQL", async () => {
    const f = fixture();
    try {
      f.insert("one");
      const userId = "user-1' OR 1=1 --";
      expect(await getRecentLoginEvents(f.db, 50, 0, { userId })).toEqual({ total: 0, events: [] });
      for (const [sql] of f.prepare.mock.calls) {
        expect(sql).not.toContain(userId);
        expect(sql).toContain("user_id = ?");
      }
    } finally {
      f.sqlite.close();
    }
  });
});
