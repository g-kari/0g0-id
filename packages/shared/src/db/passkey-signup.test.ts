/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createEmailSignupIntent,
  claimEmailSignupDelivery,
  verifyEmailSignupIntent,
} from "./email-signup-intents";
import {
  issuePendingEmailPasskeySignup,
  findPendingEmailPasskeySignup,
  completeVerifiedEmailPasskeySignup,
  reconcileEmailPasskeySignup,
  type VerifiedSignupCredential,
} from "./passkey-signup";
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
describe("atomic pending email/passkey signup (SQLite)", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T20:00:00Z"));
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, email_verified INTEGER NOT NULL,
        name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', banned_at TEXT);
      INSERT INTO users VALUES ('existing','existing@example.test',1,'Fixture','user',NULL);`);
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
  async function setup(email = "new@example.test") {
    const delivery = (await createEmailSignupIntent(db, { ...binding, email }))!;
    const proof = { ...binding, ...delivery };
    await claimEmailSignupDelivery(db, proof);
    const verified = (await verifyEmailSignupIntent(db, proof))!;
    const authority = { ...binding, intentId: verified.id, authority: verified.authority };
    const pending = (await issuePendingEmailPasskeySignup(db, authority))!;
    const credential: VerifiedSignupCredential = {
      verified: true,
      ownerID: pending.user_id,
      webAuthnUserID: pending.webauthn_user_id,
      credentialId: "verified-credential",
      publicKey: "verified-COSE-public-key",
      counter: 0,
      deviceType: "multiDevice",
      backedUp: true,
      transports: ["internal"],
    };
    return {
      authority,
      pending,
      complete: {
        ...authority,
        pendingId: pending.id,
        challenge: pending.challenge,
        name: "Synthetic",
        credential,
      },
    };
  }
  function count(table: string) {
    return Number(sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()?.n);
  }
  function assertUntouched(id: string) {
    expect(count("users")).toBe(1);
    expect(count("passkey_credentials")).toBe(0);
    expect(count("passkey_user_handles")).toBe(0);
    expect(count("passkey_signup_commit_guards")).toBe(0);
    expect(
      sqlite.prepare("SELECT consumed_at FROM email_signup_intents WHERE id=?").get(id)
        ?.consumed_at,
    ).toBeNull();
    expect(count("passkey_signup_pending")).toBe(1);
  }

  it("reserves opaque IDs/challenge without creating a user and resumes the same live enrollment", async () => {
    const { authority, pending } = await setup();
    expect(count("users")).toBe(1);
    expect(pending.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.webauthn_user_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.expires_at).toBe(Date.now() / 1000 + 300);
    expect(await issuePendingEmailPasskeySignup(db, authority)).toBeNull();
    expect(
      await findPendingEmailPasskeySignup(db, { ...authority, pendingId: pending.id }),
    ).toEqual(pending);
  });

  it("does not extend the email intent's original deadline", async () => {
    const d = (await createEmailSignupIntent(db, { ...binding, email: "late@example.test" }))!;
    await claimEmailSignupDelivery(db, { ...binding, ...d });
    vi.advanceTimersByTime(800_000);
    const v = (await verifyEmailSignupIntent(db, { ...binding, ...d }))!;
    const p = (await issuePendingEmailPasskeySignup(db, {
      ...binding,
      intentId: v.id,
      authority: v.authority,
    }))!;
    expect(p.expires_at).toBe(d.expiresAt);
  });

  it("atomically creates one ordinary user/key and consumes authority/pending", async () => {
    const { complete, pending, authority } = await setup();
    const result = await completeVerifiedEmailPasskeySignup(db, complete);
    expect(result.status).toBe("created");
    expect(count("users")).toBe(2);
    expect(count("passkey_credentials")).toBe(1);
    expect(count("passkey_signup_pending")).toBe(0);
    expect(count("passkey_signup_commit_guards")).toBe(0);
    expect(
      sqlite.prepare("SELECT role,email_verified FROM users WHERE id=?").get(pending.user_id),
    ).toEqual({ role: "user", email_verified: 1 });
    expect(
      sqlite
        .prepare("SELECT consumed_at FROM email_signup_intents WHERE id=?")
        .get(authority.intentId)?.consumed_at,
    ).toBe(Date.now() / 1000);
    if (result.status !== "created") throw new Error("fixture signup failed");
    expect(await reconcileEmailPasskeySignup(db, result.receipt)).toEqual({
      userId: pending.user_id,
    });
    expect((await completeVerifiedEmailPasskeySignup(db, complete)).status).not.toBe("created");
    expect(count("users")).toBe(2);
  });

  it("allows only one concurrent completion", async () => {
    const { complete } = await setup();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => completeVerifiedEmailPasskeySignup(db, complete)),
    );
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    expect(count("passkey_credentials")).toBe(1);
    expect(count("users")).toBe(2);
  });

  it.each([
    { authority: "B".repeat(43) },
    { browserBinding: "B".repeat(43) },
    { idpOrigin: "https://evil.example.test" },
    { challenge: "B".repeat(43) },
    { pendingId: "missing" },
  ])("rejects mismatched authority/context and rolls back everything: %j", async (override) => {
    const { complete, authority } = await setup();
    expect(
      (await completeVerifiedEmailPasskeySignup(db, { ...complete, ...override })).status,
    ).not.toBe("created");
    assertUntouched(authority.intentId);
  });

  it.each(["ownerID", "webAuthnUserID"] as const)(
    "rejects a different verifier subject %s",
    async (field) => {
      const { complete, authority } = await setup();
      expect(
        (
          await completeVerifiedEmailPasskeySignup(db, {
            ...complete,
            credential: { ...complete.credential, [field]: "B".repeat(43) },
          })
        ).status,
      ).not.toBe("created");
      assertUntouched(authority.intentId);
    },
  );

  it("rejects the exact pending expiry without consuming email authority", async () => {
    const { complete, authority } = await setup();
    vi.advanceTimersByTime(300_000);
    expect((await completeVerifiedEmailPasskeySignup(db, complete)).status).not.toBe("created");
    expect(
      await findPendingEmailPasskeySignup(db, { ...authority, pendingId: complete.pendingId }),
    ).toBeNull();
    assertUntouched(authority.intentId);
  });

  it.each([
    ["INSERT", "users", ""],
    ["INSERT", "passkey_credentials", ""],
    ["INSERT", "passkey_user_handles", ""],
    ["UPDATE", "email_signup_intents", "WHEN NEW.consumed_at IS NOT NULL"],
    ["DELETE", "passkey_signup_pending", ""],
  ])("rolls back even a zero-row ignored %s on %s", async (operation, table, condition) => {
    const { complete, authority } = await setup();
    sqlite.exec(
      `CREATE TRIGGER ignore_statement BEFORE ${operation} ON ${table} ${condition} BEGIN SELECT RAISE(IGNORE); END`,
    );
    expect((await completeVerifiedEmailPasskeySignup(db, complete)).status).not.toBe("created");
    assertUntouched(authority.intentId);
  });

  it("rolls back an existing credential collision without moving its owner", async () => {
    const { complete, authority } = await setup();
    sqlite
      .prepare(`INSERT INTO passkey_credentials (credential_id,registration_id,user_id,public_key,sign_count,device_type,backed_up,created_at)
      VALUES (?,'old-registration','existing','old-key',0,'singleDevice',0,0)`)
      .run(complete.credential.credentialId);
    expect((await completeVerifiedEmailPasskeySignup(db, complete)).status).not.toBe("created");
    expect(count("users")).toBe(1);
    expect(count("passkey_credentials")).toBe(1);
    expect(sqlite.prepare("SELECT user_id FROM passkey_credentials").get()?.user_id).toBe(
      "existing",
    );
    expect(
      sqlite
        .prepare("SELECT consumed_at FROM email_signup_intents WHERE id=?")
        .get(authority.intentId)?.consumed_at,
    ).toBeNull();
  });

  it("rejects a raced email account without linking or promoting it", async () => {
    const { complete, authority } = await setup();
    sqlite.exec("INSERT INTO users VALUES ('racer','NEW@example.test',1,'Racer','admin',NULL)");
    expect((await completeVerifiedEmailPasskeySignup(db, complete)).status).not.toBe("created");
    expect(count("users")).toBe(2);
    expect(count("passkey_credentials")).toBe(0);
    expect(sqlite.prepare("SELECT role FROM users WHERE id='racer'").get()?.role).toBe("admin");
    expect(
      sqlite
        .prepare("SELECT consumed_at FROM email_signup_intents WHERE id=?")
        .get(authority.intentId)?.consumed_at,
    ).toBeNull();
  });

  it("reconciles a lost success response without retrying or authorizing a login", async () => {
    const { complete, pending } = await setup();
    const originalBatch = db.batch.bind(db);
    let receipt: unknown;
    const failing = {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        const results = await originalBatch(statements);
        receipt = results;
        throw new Error("simulated lost response");
      },
    } as unknown as D1Database;
    const result = await completeVerifiedEmailPasskeySignup(failing, complete);
    expect(receipt).toBeDefined();
    expect(result.status).toBe("uncertain");
    if (result.status !== "uncertain") throw new Error("expected uncertain");
    expect(await reconcileEmailPasskeySignup(db, result.receipt)).toEqual({
      userId: pending.user_id,
    });
    expect((await completeVerifiedEmailPasskeySignup(db, complete)).status).not.toBe("created");
    expect(count("users")).toBe(2);
  });
  it("preserves the stable handle after pending deletion and cascades on user deletion", async () => {
    const { complete, pending } = await setup();
    expect((await completeVerifiedEmailPasskeySignup(db, complete)).status).toBe("created");
    expect(
      sqlite
        .prepare("SELECT webauthn_user_id FROM passkey_user_handles WHERE user_id=?")
        .get(pending.user_id)?.webauthn_user_id,
    ).toBe(pending.webauthn_user_id);
    sqlite.prepare("DELETE FROM users WHERE id=?").run(pending.user_id);
    expect(count("passkey_user_handles")).toBe(0);
    expect(count("passkey_credentials")).toBe(0);
  });
  it.each([
    ["INSERT", "passkey_signup_commit_guards", "WHEN NEW.proof LIKE 'pending:%'"],
    ["INSERT", "users", ""],
    ["INSERT", "passkey_user_handles", ""],
    ["INSERT", "passkey_credentials", ""],
    ["UPDATE", "email_signup_intents", "WHEN NEW.consumed_at IS NOT NULL"],
    ["DELETE", "passkey_signup_pending", ""],
    ["INSERT", "passkey_signup_commit_guards", "WHEN NEW.proof LIKE 'completed:%'"],
    ["DELETE", "passkey_signup_commit_guards", ""],
  ])("rolls back forced ABORT at %s %s", async (operation, table, condition) => {
    const { complete, authority } = await setup();
    sqlite.exec(
      `CREATE TRIGGER abort_statement BEFORE ${operation} ON ${table} ${condition} BEGIN SELECT RAISE(ABORT,'fixture'); END`,
    );
    expect((await completeVerifiedEmailPasskeySignup(db, complete)).status).not.toBe("created");
    assertUntouched(authority.intentId);
  });
  it("treats ignored guard cleanup as uncertain and never reuses residual guards", async () => {
    const { complete, pending } = await setup();
    sqlite.exec(
      "CREATE TRIGGER ignore_guard_cleanup BEFORE DELETE ON passkey_signup_commit_guards BEGIN SELECT RAISE(IGNORE); END",
    );
    const result = await completeVerifiedEmailPasskeySignup(db, complete);
    expect(result.status).toBe("uncertain");
    expect(count("users")).toBe(2);
    expect(count("passkey_signup_commit_guards")).toBe(2);
    if (result.status !== "uncertain") throw new Error("expected uncertain");
    expect(await reconcileEmailPasskeySignup(db, result.receipt)).toEqual({
      userId: pending.user_id,
    });
    expect((await completeVerifiedEmailPasskeySignup(db, complete)).status).not.toBe("created");
    expect(count("users")).toBe(2);
  });
});
