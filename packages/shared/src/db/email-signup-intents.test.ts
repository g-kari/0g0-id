/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  deliverEmailSignupIntent,
  claimEmailSignupDelivery,
  createEmailSignupIntent,
  findVerifiedEmailSignupIntent,
  finishEmailSignupDelivery,
  settleAbandonedEmailSignupDeliveries,
  verifyEmailSignupIntent,
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

const binding = { browserBinding: "A".repeat(43), idpOrigin: "https://id.example.test" };
const request = { ...binding, email: "Local+tag@EXAMPLE.TEST" };

describe("email signup intent and delivery ledger (SQLite)", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T20:00:00Z"));
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, email_verified INTEGER, banned_at TEXT);
      INSERT INTO users VALUES ('existing', 'Existing@example.test', 1, NULL);`);
    sqlite.exec(
      readFileSync(
        new URL("../../../../docs/proposals/passkey-schema.sql", import.meta.url),
        "utf8",
      ),
    );
    db = d1Adapter(sqlite);
  });
  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });
  async function delivery() {
    const value = await createEmailSignupIntent(db, request);
    expect(value).not.toBeNull();
    return { ...binding, ...value! };
  }
  function outbox(id: string) {
    return sqlite.prepare("SELECT * FROM email_signup_outbox WHERE intent_id = ?").get(id);
  }
  function intent(id: string) {
    return sqlite.prepare("SELECT * FROM email_signup_intents WHERE id = ?").get(id);
  }

  it("atomically stores only proof/binding hashes and a queued ledger, preserving local-part", async () => {
    const value = await delivery();
    expect(value.recipient).toBe("Local+tag@example.test");
    expect(value.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = intent(value.intentId)!;
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.browser_binding_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.expires_at).toBe(Date.now() / 1000 + 900);
    expect(JSON.stringify(row)).not.toContain(value.token);
    expect(JSON.stringify(row)).not.toContain(binding.browserBinding);
    expect(outbox(value.intentId)?.state).toBe("queued");
  });

  it("rolls back the intent if outbox insertion fails", async () => {
    sqlite.exec(
      "CREATE TRIGGER refuse_outbox BEFORE INSERT ON email_signup_outbox BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    await expect(createEmailSignupIntent(db, request)).rejects.toThrow();
    expect(sqlite.prepare("SELECT count(*) n FROM email_signup_intents").get()?.n).toBe(0);
  });

  it.each(["existing@example.test", "EXISTING@example.test"])(
    "never creates a proof for existing account %s",
    async (email) => {
      expect(await createEmailSignupIntent(db, { ...request, email })).toBeNull();
      expect(sqlite.prepare("SELECT count(*) n FROM email_signup_outbox").get()?.n).toBe(0);
    },
  );

  it.each([
    "invalid",
    "a@localhost",
    "a@127.0.0.1",
    "a@x.test\r\nBcc: b@x.test",
    "a@x.test\n",
    "a..b@x.test",
    "日本語@x.test",
    "a@example..test",
  ])("rejects unsupported mailbox %s", async (email) => {
    await expect(createEmailSignupIntent(db, { ...request, email })).rejects.toThrow();
  });

  it.each(["", "short", "!".repeat(43)])(
    "rejects malformed browser binding",
    async (browserBinding) => {
      await expect(createEmailSignupIntent(db, { ...request, browserBinding })).rejects.toThrow();
    },
  );

  it("rejects an untrusted non-origin URL before storing", async () => {
    await expect(
      createEmailSignupIntent(db, { ...request, idpOrigin: "https://id.example.test/evil" }),
    ).rejects.toThrow();
  });

  it("caps email attempts even across new browsers and domain/local case variants", async () => {
    for (let n = 0; n < 3; n++)
      expect(
        await createEmailSignupIntent(db, { ...request, browserBinding: String(n).repeat(43) }),
      ).not.toBeNull();
    expect(
      await createEmailSignupIntent(db, {
        ...request,
        email: request.email.toLowerCase(),
        browserBinding: "Z".repeat(43),
      }),
    ).toBeNull();
  });

  it("caps a browser across addresses and concurrent requests", async () => {
    const values = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        createEmailSignupIntent(db, { ...request, email: `a${n}@example.test` }),
      ),
    );
    expect(values.filter(Boolean)).toHaveLength(5);
    expect(sqlite.prepare("SELECT count(*) n FROM email_signup_outbox").get()?.n).toBe(5);
  });

  it("retains rate evidence after expiry and settlement", async () => {
    for (let n = 0; n < 3; n++) await createEmailSignupIntent(db, request);
    vi.advanceTimersByTime(901_000);
    await settleAbandonedEmailSignupDeliveries(db);
    expect(await createEmailSignupIntent(db, request)).toBeNull();
    vi.advanceTimersByTime(2_700_000);
    expect(await createEmailSignupIntent(db, request)).not.toBeNull();
  });

  it("permits exactly one claim, bound to the original payload", async () => {
    const value = await delivery();
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => claimEmailSignupDelivery(db, value)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.expiresAt).toBe(value.expiresAt);
    expect(outbox(value.intentId)?.state).toBe("claimed");
  });

  it.each([
    { token: "B".repeat(43) },
    { token: "invalid" },
    { recipient: "other@example.test" },
    { browserBinding: "B".repeat(43) },
    { idpOrigin: "https://evil.example.test" },
    { intentId: "missing" },
  ])("does not consume an outbox with a mismatched proof: %j", async (override) => {
    const value = await delivery();
    expect(await claimEmailSignupDelivery(db, { ...value, ...override })).toBeNull();
    expect(outbox(value.intentId)?.state).toBe("queued");
    expect(await claimEmailSignupDelivery(db, value)).not.toBeNull();
  });

  it("does not accept another intent's token", async () => {
    const a = await delivery();
    const b = await delivery();
    expect(await claimEmailSignupDelivery(db, { ...a, token: b.token })).toBeNull();
  });

  it.each(["claim", "verify"])("rejects exact expiry at %s", async (operation) => {
    const value = await delivery();
    if (operation === "verify") await claimEmailSignupDelivery(db, value);
    vi.advanceTimersByTime(900_000);
    expect(
      await (operation === "claim"
        ? claimEmailSignupDelivery(db, value)
        : verifyEmailSignupIntent(db, value)),
    ).toBeNull();
  });

  it("cannot verify an unsent queued or discarded proof", async () => {
    const value = await delivery();
    expect(await verifyEmailSignupIntent(db, value)).toBeNull();
  });

  it.each(["accepted", "uncertain", "claimed"] as const)(
    "verifies once after %s and atomically installs only an authority hash",
    async (state) => {
      const value = await delivery();
      const claim = (await claimEmailSignupDelivery(db, value))!;
      if (state !== "claimed")
        await finishEmailSignupDelivery(
          db,
          value.intentId,
          claim.claimId,
          state === "accepted" ? { state, messageId: "provider-id" } : { state },
        );
      const results = await Promise.all(
        Array.from({ length: 5 }, () => verifyEmailSignupIntent(db, value)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const verified = results.find(Boolean)!;
      expect(verified.expires_at).toBe(value.expiresAt);
      expect(intent(value.intentId)?.token_hash).toBeNull();
      expect(JSON.stringify(intent(value.intentId))).not.toContain(verified.authority);
      expect(
        await findVerifiedEmailSignupIntent(db, {
          ...binding,
          intentId: value.intentId,
          authority: verified.authority,
        }),
      ).toEqual({ id: value.intentId, email: value.recipient, expires_at: value.expiresAt });
      expect(
        await findVerifiedEmailSignupIntent(db, {
          ...binding,
          intentId: value.intentId,
          authority: value.token,
        }),
      ).toBeNull();
    },
  );

  it.each([
    { browserBinding: "B".repeat(43) },
    { idpOrigin: "https://evil.example.test" },
    { token: "B".repeat(43) },
  ])("rejects mismatched verification without consuming proof", async (override) => {
    const value = await delivery();
    await claimEmailSignupDelivery(db, value);
    expect(await verifyEmailSignupIntent(db, { ...value, ...override })).toBeNull();
    expect(await verifyEmailSignupIntent(db, value)).not.toBeNull();
  });

  it("does not turn provider rejection or acceptance alone into ownership", async () => {
    const value = await delivery();
    const claim = (await claimEmailSignupDelivery(db, value))!;
    await finishEmailSignupDelivery(db, value.intentId, claim.claimId, {
      state: "rejected",
      code: "E_RECIPIENT_SUPPRESSED",
    });
    expect(await verifyEmailSignupIntent(db, value)).toBeNull();
    expect(intent(value.intentId)?.verified_at).toBeNull();
  });

  it("rechecks an account created after proof issuance and never links it", async () => {
    const value = await delivery();
    await claimEmailSignupDelivery(db, value);
    sqlite
      .prepare("INSERT INTO users VALUES ('racer', ?, 1, NULL)")
      .run(value.recipient.toLowerCase());
    expect(await verifyEmailSignupIntent(db, value)).toBeNull();
  });

  it("binds authority to browser and origin, expiry and consumption", async () => {
    const value = await delivery();
    await claimEmailSignupDelivery(db, value);
    const verified = (await verifyEmailSignupIntent(db, value))!;
    const input = { ...binding, intentId: value.intentId, authority: verified.authority };
    expect(
      await findVerifiedEmailSignupIntent(db, { ...input, browserBinding: "B".repeat(43) }),
    ).toBeNull();
    expect(
      await findVerifiedEmailSignupIntent(db, { ...input, idpOrigin: "https://evil.example.test" }),
    ).toBeNull();
    sqlite
      .prepare("UPDATE email_signup_intents SET consumed_at = ? WHERE id = ?")
      .run(Date.now() / 1000, value.intentId);
    expect(await findVerifiedEmailSignupIntent(db, input)).toBeNull();
  });

  it("does not extend a verified authority's expiry", async () => {
    const value = await delivery();
    await claimEmailSignupDelivery(db, value);
    const verified = (await verifyEmailSignupIntent(db, value))!;
    vi.advanceTimersByTime(900_000);
    expect(
      await findVerifiedEmailSignupIntent(db, {
        ...binding,
        intentId: value.intentId,
        authority: verified.authority,
      }),
    ).toBeNull();
  });

  it("finalizes only the matching claim and never overwrites a terminal result", async () => {
    const value = await delivery();
    const claim = (await claimEmailSignupDelivery(db, value))!;
    expect(
      await finishEmailSignupDelivery(db, value.intentId, "wrong", {
        state: "accepted",
        messageId: "id",
      }),
    ).toBe(false);
    expect(
      await finishEmailSignupDelivery(db, value.intentId, claim.claimId, { state: "uncertain" }),
    ).toBe(true);
    expect(
      await finishEmailSignupDelivery(db, value.intentId, claim.claimId, {
        state: "accepted",
        messageId: "late-id",
      }),
    ).toBe(false);
    expect(await claimEmailSignupDelivery(db, value)).toBeNull();
  });

  it("does not persist raw provider messages or invalid identifiers", async () => {
    const value = await delivery();
    const claim = (await claimEmailSignupDelivery(db, value))!;
    expect(
      await finishEmailSignupDelivery(db, value.intentId, claim.claimId, {
        state: "rejected",
        code: value.token,
      }),
    ).toBe(false);
    expect(
      await finishEmailSignupDelivery(db, value.intentId, claim.claimId, {
        state: "accepted",
        messageId: "bad\nheader",
      }),
    ).toBe(false);
    expect(outbox(value.intentId)?.state).toBe("claimed");
  });

  it("settles abandoned claims as uncertain, expires queued, retains records then cascades cleanup", async () => {
    const a = await delivery();
    const b = await delivery();
    const claim = (await claimEmailSignupDelivery(db, a))!;
    vi.advanceTimersByTime(60_000);
    await settleAbandonedEmailSignupDeliveries(db);
    expect(outbox(a.intentId)?.state).toBe("uncertain");
    expect(
      await finishEmailSignupDelivery(db, a.intentId, claim.claimId, {
        state: "accepted",
        messageId: "late",
      }),
    ).toBe(false);
    expect(await verifyEmailSignupIntent(db, a)).not.toBeNull();
    vi.advanceTimersByTime(840_000);
    await settleAbandonedEmailSignupDeliveries(db);
    expect(outbox(b.intentId)?.state).toBe("discarded");
    expect(intent(b.intentId)).toBeDefined();
    vi.advanceTimersByTime(86_400_000);
    await settleAbandonedEmailSignupDeliveries(db);
    expect(intent(a.intentId)).toBeUndefined();
    expect(outbox(a.intentId)).toBeUndefined();
    expect(outbox(b.intentId)).toBeUndefined();
  });
  it("coordinates one callback across concurrent and repeated delivery attempts", async () => {
    const value = await delivery();
    const send = vi.fn().mockResolvedValue({ outcome: "accepted", messageId: "provider-id" });
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => deliverEmailSignupIntent(db, value, send)),
    );
    expect(attempts.filter((v) => v === "accepted")).toHaveLength(1);
    expect(send).toHaveBeenCalledExactlyOnceWith({
      recipient: value.recipient,
      token: value.token,
      expiresAt: value.expiresAt,
    });
    expect(await deliverEmailSignupIntent(db, value, send)).toBe("not_claimed");
    expect(outbox(value.intentId)?.state).toBe("accepted");
    expect(intent(value.intentId)?.verified_at).toBeNull();
  });

  it("contains callback exceptions, records uncertainty and never sends again", async () => {
    const value = await delivery();
    const send = vi.fn().mockRejectedValue(new Error(value.token));
    expect(await deliverEmailSignupIntent(db, value, send)).toBe("uncertain");
    expect(await deliverEmailSignupIntent(db, value, send)).toBe("not_claimed");
    expect(send).toHaveBeenCalledOnce();
    expect(outbox(value.intentId)?.state).toBe("uncertain");
  });

  it("does not send again after final persistence fails following provider acceptance", async () => {
    const value = await delivery();
    sqlite.exec(
      "CREATE TRIGGER refuse_finish BEFORE UPDATE ON email_signup_outbox WHEN NEW.state = 'accepted' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    const send = vi.fn().mockResolvedValue({ outcome: "accepted", messageId: "provider-id" });
    expect(await deliverEmailSignupIntent(db, value, send)).toBe("uncertain");
    expect(outbox(value.intentId)?.state).toBe("claimed");
    expect(await deliverEmailSignupIntent(db, value, send)).toBe("not_claimed");
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    { outcome: "disabled" },
    { outcome: "uncertain" },
    { outcome: "accepted", messageId: "bad\nheader" },
    { outcome: "rejected", code: "unknown-provider-text" },
  ])(
    "does not claim a definite delivery result from unsafe callback output: %j",
    async (result) => {
      const value = await delivery();
      const send = vi.fn().mockResolvedValue(result);
      expect(await deliverEmailSignupIntent(db, value, send)).toBe("uncertain");
      expect(outbox(value.intentId)?.state).toBe("uncertain");
    },
  );
  it("correlates each proof to its own outbox and returns its own expiry", async () => {
    const a = await delivery();
    vi.advanceTimersByTime(10_000);
    const b = await delivery();
    const ca = (await claimEmailSignupDelivery(db, a))!;
    expect(ca.expiresAt).toBe(a.expiresAt);
    expect(await verifyEmailSignupIntent(db, b)).toBeNull();
    const cb = (await claimEmailSignupDelivery(db, b))!;
    expect(cb.expiresAt).toBe(b.expiresAt);
    expect(cb.expiresAt).not.toBe(ca.expiresAt);
    expect(await verifyEmailSignupIntent(db, b)).not.toBeNull();
  });

  it("rejects another intent's authority and an account created after verification", async () => {
    const a = await delivery();
    const b = await delivery();
    await claimEmailSignupDelivery(db, a);
    await claimEmailSignupDelivery(db, b);
    const va = (await verifyEmailSignupIntent(db, a))!;
    const vb = (await verifyEmailSignupIntent(db, b))!;
    expect(
      await findVerifiedEmailSignupIntent(db, {
        ...binding,
        intentId: a.intentId,
        authority: vb.authority,
      }),
    ).toBeNull();
    sqlite.prepare("INSERT INTO users VALUES ('racer', ?, 1, NULL)").run(a.recipient);
    expect(
      await findVerifiedEmailSignupIntent(db, {
        ...binding,
        intentId: a.intentId,
        authority: va.authority,
      }),
    ).toBeNull();
  });

  it("does not settle an active 59-second claim, settles at exactly 60 seconds", async () => {
    const a = await delivery();
    await claimEmailSignupDelivery(db, a);
    vi.advanceTimersByTime(59_000);
    await settleAbandonedEmailSignupDeliveries(db);
    expect(outbox(a.intentId)?.state).toBe("claimed");
    vi.advanceTimersByTime(1_000);
    await settleAbandonedEmailSignupDeliveries(db);
    expect(outbox(a.intentId)?.state).toBe("uncertain");
  });

  it("retains the inclusive 3600-second rate boundary and permits a new attempt one second later", async () => {
    for (let n = 0; n < 3; n++) await createEmailSignupIntent(db, request);
    vi.advanceTimersByTime(3_600_000);
    expect(await createEmailSignupIntent(db, request)).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(await createEmailSignupIntent(db, request)).not.toBeNull();
  });
});
