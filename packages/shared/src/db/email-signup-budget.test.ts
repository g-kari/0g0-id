/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL as NodeURL, fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createEmailSignupIntent,
  deliverEmailSignupIntent,
  settleAbandonedEmailSignupDeliveries,
  type EmailSignupSender,
} from "./email-signup-intents";

function d1Adapter(sqlite: DatabaseSync): D1Database {
  function prepare(sql: string) {
    return {
      bind(...values: SQLInputValue[]) {
        return {
          sql,
          values,
          async first<T>(): Promise<T | null> {
            return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null;
          },
          async run() {
            return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
          },
        };
      },
    };
  }
  return {
    prepare,
    async batch(statements: { sql: string; values: SQLInputValue[] }[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(({ sql, values }) => ({
          meta: {
            changes: Number(sqlite.prepare(sql).run(...values).changes),
          },
        }));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

// Every allocation uses a distinct synthetic email/browser so the global budget,
// rather than the per-email or per-browser rolling limits, is under test.
function request(index: number, dailyLimit = 3) {
  return {
    email: `budget-${index}@example.test`,
    browserBinding: index.toString(36).padStart(43, "A"),
    idpOrigin: "https://id.example.test",
    dailyLimit,
  };
}

describe("atomic UTC-day signup allocation budget (SQLite)", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, email_verified INTEGER, banned_at TEXT);`);
    sqlite.exec(
      readFileSync(
        fileURLToPath(
          new NodeURL("../../../../docs/proposals/passkey-schema.sql", import.meta.url),
        ),
        "utf8",
      ),
    );
    db = d1Adapter(sqlite);
  });
  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });
  function counts() {
    return {
      intents: sqlite.prepare("SELECT count(*) AS n FROM email_signup_intents").get()?.n,
      outbox: sqlite.prepare("SELECT count(*) AS n FROM email_signup_outbox").get()?.n,
    };
  }

  it("allocates exactly the cap under concurrent requests with independent identities", async () => {
    // Promise concurrency exercises competing async hash/batch calls. SQLite's
    // BEGIN IMMEDIATE serializes each real SQL transaction, as D1 batches do.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => createEmailSignupIntent(db, request(i))),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(new Set(results.filter(Boolean).map((value) => value!.intentId)).size).toBe(3);
    expect(counts()).toEqual({ intents: 3, outbox: 3 });
    expect(await createEmailSignupIntent(db, request(50))).toBeNull();
  });

  it.each([
    { outcome: "accepted", messageId: "synthetic-budget-message" },
    { outcome: "rejected", code: "E_RECIPIENT_SUPPRESSED" },
    { outcome: "uncertain" },
  ] satisfies Awaited<ReturnType<EmailSignupSender>>[])(
    "does not refund allocation after $outcome delivery",
    async (outcome) => {
      const input = request(0, 1);
      const value = await createEmailSignupIntent(db, input);
      expect(value).not.toBeNull();
      const send = vi.fn<EmailSignupSender>().mockResolvedValue(outcome);
      expect(await deliverEmailSignupIntent(db, { ...input, ...value! }, send)).toBe(
        outcome.outcome,
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(await deliverEmailSignupIntent(db, { ...input, ...value! }, send)).toBe("not_claimed");
      expect(send).toHaveBeenCalledTimes(1);
      expect(await createEmailSignupIntent(db, request(1, 1))).toBeNull();
      expect(counts()).toEqual({ intents: 1, outbox: 1 });
    },
  );

  it("gives a stable request one winner without spending extra slots or resending", async () => {
    const input = { ...request(0, 2), serverIntentId: crypto.randomUUID() };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => createEmailSignupIntent(db, input)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.find((value) => value !== null)!;
    const send = vi
      .fn<EmailSignupSender>()
      .mockResolvedValue({ outcome: "accepted", messageId: "one-send" });
    expect(await deliverEmailSignupIntent(db, { ...input, ...winner }, send)).toBe("accepted");
    expect(await createEmailSignupIntent(db, input)).toBeNull();
    expect(await deliverEmailSignupIntent(db, { ...input, ...winner }, send)).toBe("not_claimed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(await createEmailSignupIntent(db, request(1, 2))).not.toBeNull();
    expect(await createEmailSignupIntent(db, input)).toBeNull();
    expect(await createEmailSignupIntent(db, request(2, 2))).toBeNull();
    expect(counts()).toEqual({ intents: 2, outbox: 2 });
  });

  it("resets exactly at UTC midnight while retaining yesterday's allocations", async () => {
    vi.setSystemTime(new Date("2026-11-07T23:59:59.999Z"));
    expect(await createEmailSignupIntent(db, request(0, 1))).not.toBeNull();
    expect(await createEmailSignupIntent(db, request(1, 1))).toBeNull();
    vi.setSystemTime(new Date("2026-11-08T00:00:00.000Z"));
    expect(await createEmailSignupIntent(db, request(2, 1))).not.toBeNull();
    expect(await createEmailSignupIntent(db, request(3, 1))).toBeNull();
    expect(counts()).toEqual({ intents: 2, outbox: 2 });
  });

  it("old-day retention and cleanup cannot reset a spent current-day budget", async () => {
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    const old = await createEmailSignupIntent(db, request(0, 1));
    vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
    const today = await createEmailSignupIntent(db, request(1, 1));
    expect(old).not.toBeNull();
    expect(today).not.toBeNull();
    expect(counts()).toEqual({ intents: 2, outbox: 2 });
    // Even expiry/discarding later in the day must not erase budget evidence.
    vi.setSystemTime(new Date("2026-11-07T23:59:59Z"));
    await settleAbandonedEmailSignupDeliveries(db);
    expect(counts()).toEqual({ intents: 1, outbox: 1 });
    expect(sqlite.prepare("SELECT id FROM email_signup_intents").get()?.id).toBe(today!.intentId);
    expect(sqlite.prepare("SELECT state FROM email_signup_outbox").get()?.state).toBe("discarded");
    expect(await createEmailSignupIntent(db, request(2, 1))).toBeNull();
    await settleAbandonedEmailSignupDeliveries(db);
    expect(await createEmailSignupIntent(db, request(3, 1))).toBeNull();
    expect(counts()).toEqual({ intents: 1, outbox: 1 });
  });

  it.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid limit %s before any database operation",
    async (dailyLimit) => {
      const prepare = vi.spyOn(db, "prepare");
      const batch = vi.spyOn(db, "batch");
      await expect(createEmailSignupIntent(db, request(0, dailyLimit))).rejects.toThrow(
        "Invalid signup budget",
      );
      expect(prepare).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
      expect(counts()).toEqual({ intents: 0, outbox: 0 });
    },
  );

  it("accepts the largest safe integer and leaves the legacy optional limit compatible", async () => {
    expect(await createEmailSignupIntent(db, request(0, Number.MAX_SAFE_INTEGER))).not.toBeNull();
    expect(
      await createEmailSignupIntent(db, { ...request(1), dailyLimit: undefined }),
    ).not.toBeNull();
    expect(counts()).toEqual({ intents: 2, outbox: 2 });
  });
});
