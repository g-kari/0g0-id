/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  cleanupExpiredPasskeyChallenges,
  consumePasskeyChallenge,
  findPasskeyChallenge,
  issuePasskeyChallenge,
  passkeyRelyingParty,
  type PasskeyChallengeBinding,
} from "./passkey-challenges";
import {
  findPasskeyCredential,
  recordVerifiedPasskeyAuthentication,
  storeVerifiedPasskey,
} from "./passkey-credentials";

// Real SQLite executes the same statements used by D1, including RETURNING,
// NULL identity matching, constraints, foreign keys and compare-and-swap.
function d1Adapter(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: SQLInputValue[]) {
          return {
            async first<T>(): Promise<T | null> {
              return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null;
            },
            async run() {
              return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const registration = {
  ceremony: "registration" as const,
  userId: "verified-user",
  browserBinding: "A".repeat(43),
  idpOrigin: "https://id.0g0.xyz",
};
const credential = {
  credentialId: "verified-credential",
  userId: registration.userId,
  publicKey: "verified-COSE-public-key",
  counter: 1,
  deviceType: "singleDevice" as const,
  backedUp: false,
};

describe("passkeyRelyingParty", () => {
  it("uses the configured IdP origin and host, never the parent domain", () => {
    expect(passkeyRelyingParty("https://id.0g0.xyz/")).toEqual({
      origin: "https://id.0g0.xyz",
      rpId: "id.0g0.xyz",
    });
    expect(passkeyRelyingParty("https://id.0g0.xyz:8443")).toEqual({
      origin: "https://id.0g0.xyz:8443",
      rpId: "id.0g0.xyz",
    });
  });

  it.each([
    "http://id.0g0.xyz",
    "https://id.0g0.xyz/path",
    "https://id.0g0.xyz?query=1",
    "https://id.0g0.xyz#fragment",
    "https://user:password@id.0g0.xyz",
    "https://id.0g0.xyz.",
    "https://*.0g0.xyz",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "not-a-url",
  ])("rejects unsafe or ambiguous configuration: %s", (origin) => {
    expect(() => passkeyRelyingParty(origin)).toThrow();
  });
});

describe("passkey storage (SQLite)", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T20:00:00Z"));
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY, email_verified INTEGER, banned_at TEXT);
      INSERT INTO users VALUES ('verified-user', 1, NULL), ('other-user', 1, NULL),
        ('unverified-user', 0, NULL), ('banned-user', 1, '2026-11-01');`);
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

  async function binding(): Promise<PasskeyChallengeBinding> {
    const row = await issuePasskeyChallenge(db, registration);
    expect(row).not.toBeNull();
    return { ...registration, id: row!.id };
  }

  it("generates independent 256-bit challenges and only stores the binding hash", async () => {
    const first = await issuePasskeyChallenge(db, registration);
    const second = await issuePasskeyChallenge(db, registration);
    expect(first!.id).not.toBe(second!.id);
    expect(first!.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first!.challenge).not.toBe(second!.challenge);
    expect(first!.browser_binding_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain(registration.browserBinding);
    expect(first!.expires_at).toBe(Math.floor(Date.now() / 1000) + 300);
  });

  it.each(["unverified-user", "banned-user", "missing-user"])(
    "does not issue a registration challenge for %s",
    async (userId) => {
      expect(await issuePasskeyChallenge(db, { ...registration, userId })).toBeNull();
    },
  );

  it("allows a user-unbound authentication challenge, never a user-unbound registration", async () => {
    const input = { ...registration, ceremony: "authentication" as const, userId: null };
    const row = await issuePasskeyChallenge(db, input);
    expect(await consumePasskeyChallenge(db, { ...input, id: row!.id })).not.toBeNull();
    await expect(issuePasskeyChallenge(db, { ...registration, userId: null })).rejects.toThrow();
  });

  it.each(["", "short", "A".repeat(42), "A".repeat(44), "!".repeat(43)])(
    "rejects invalid browser binding before storage",
    async (browserBinding) => {
      await expect(
        issuePasskeyChallenge(db, { ...registration, browserBinding }),
      ).rejects.toThrow();
      expect(sqlite.prepare("SELECT count(*) AS n FROM passkey_challenges").get()?.n).toBe(0);
    },
  );

  it("allows reads but only one atomic completion, including racing requests", async () => {
    const input = await binding();
    expect(await findPasskeyChallenge(db, input)).not.toBeNull();
    expect(await findPasskeyChallenge(db, input)).not.toBeNull();
    const results = await Promise.all([
      consumePasskeyChallenge(db, input),
      consumePasskeyChallenge(db, input),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(await consumePasskeyChallenge(db, input)).toBeNull();
    expect(await findPasskeyChallenge(db, input)).toBeNull();
  });

  it("rejects a different browser, user, ceremony or origin without consuming the challenge", async () => {
    const input = await binding();
    for (const change of [
      { browserBinding: "B".repeat(43) },
      { userId: "other-user" },
      { ceremony: "authentication" as const },
      { idpOrigin: "https://other.0g0.xyz" },
      { idpOrigin: "https://id.0g0.xyz:8443" },
      { id: crypto.randomUUID() },
    ]) {
      expect(await findPasskeyChallenge(db, { ...input, ...change })).toBeNull();
      expect(await consumePasskeyChallenge(db, { ...input, ...change })).toBeNull();
    }
    expect(await consumePasskeyChallenge(db, input)).not.toBeNull();
  });

  it("rejects an expired challenge at the exact expiry boundary and cleans it up", async () => {
    const input = await binding();
    vi.advanceTimersByTime(300_000);
    expect(await findPasskeyChallenge(db, input)).toBeNull();
    expect(await consumePasskeyChallenge(db, input)).toBeNull();
    await cleanupExpiredPasskeyChallenges(db);
    expect(sqlite.prepare("SELECT count(*) AS n FROM passkey_challenges").get()?.n).toBe(0);
  });

  it("accepts a challenge just before expiry", async () => {
    const input = await binding();
    vi.advanceTimersByTime(299_000);
    expect(await consumePasskeyChallenge(db, input)).not.toBeNull();
  });

  it("does not consume a valid challenge on malformed binding input", async () => {
    const input = await binding();
    await expect(
      consumePasskeyChallenge(db, { ...input, browserBinding: "malformed" }),
    ).rejects.toThrow();
    expect(await consumePasskeyChallenge(db, input)).not.toBeNull();
  });

  it("stores a verified credential and only returns it for its owner", async () => {
    expect(await storeVerifiedPasskey(db, credential)).not.toBeNull();
    expect(await findPasskeyCredential(db, credential)).not.toBeNull();
    expect(await findPasskeyCredential(db, { ...credential, userId: "other-user" })).toBeNull();
  });

  it.each(["unverified-user", "banned-user", "missing-user"])(
    "does not register a credential for %s",
    async (userId) => {
      expect(await storeVerifiedPasskey(db, { ...credential, userId })).toBeNull();
    },
  );

  it("never reassigns an existing credential to another account", async () => {
    await storeVerifiedPasskey(db, credential);
    await expect(
      storeVerifiedPasskey(db, { ...credential, userId: "other-user" }),
    ).rejects.toThrow();
    expect((await findPasskeyCredential(db, credential))?.user_id).toBe(credential.userId);
  });

  it.each(["email_verified = 0", "banned_at = '2026-11-07'"])(
    "rejects enrollment if user status changes after challenge issuance: %s",
    async (change) => {
      const input = await binding();
      sqlite.exec(`UPDATE users SET ${change} WHERE id = 'verified-user'`);
      expect(await consumePasskeyChallenge(db, input)).not.toBeNull();
      expect(await storeVerifiedPasskey(db, credential)).toBeNull();
    },
  );

  it("updates a verified counter only if its previous snapshot still matches", async () => {
    await storeVerifiedPasskey(db, credential);
    const input = { ...credential, previousCounter: 1, newCounter: 2 };
    expect(await recordVerifiedPasskeyAuthentication(db, input)).toBe(true);
    expect(await recordVerifiedPasskeyAuthentication(db, input)).toBe(false);
    expect((await findPasskeyCredential(db, credential))?.sign_count).toBe(2);
    expect((await findPasskeyCredential(db, credential))?.last_used_at).toBe(Date.now() / 1000);
  });

  it.each([0, 1])("does not accept a non-increasing nonzero counter (%s)", async (newCounter) => {
    await storeVerifiedPasskey(db, credential);
    expect(
      await recordVerifiedPasskeyAuthentication(db, {
        ...credential,
        previousCounter: 1,
        newCounter,
      }),
    ).toBe(false);
  });

  it("supports authenticators whose counters stay zero", async () => {
    await storeVerifiedPasskey(db, { ...credential, counter: 0 });
    expect(
      await recordVerifiedPasskeyAuthentication(db, {
        ...credential,
        previousCounter: 0,
        newCounter: 0,
      }),
    ).toBe(true);
  });

  it.each([1, 0xffffffff])("allows a zero counter to advance to %s", async (newCounter) => {
    await storeVerifiedPasskey(db, { ...credential, counter: 0 });
    expect(
      await recordVerifiedPasskeyAuthentication(db, {
        ...credential,
        previousCounter: 0,
        newCounter,
      }),
    ).toBe(true);
    expect((await findPasskeyCredential(db, credential))?.sign_count).toBe(newCounter);
  });

  it("rejects an invalid previous counter", async () => {
    await storeVerifiedPasskey(db, credential);
    await expect(
      recordVerifiedPasskeyAuthentication(db, {
        ...credential,
        previousCounter: -1,
        newCounter: 2,
      }),
    ).rejects.toThrow();
  });

  it("does not record a login after credential deletion", async () => {
    await storeVerifiedPasskey(db, credential);
    sqlite
      .prepare("DELETE FROM passkey_credentials WHERE credential_id = ?")
      .run(credential.credentialId);
    expect(
      await recordVerifiedPasskeyAuthentication(db, {
        ...credential,
        previousCounter: 1,
        newCounter: 2,
      }),
    ).toBe(false);
  });

  it("does not record a login after email verification is revoked", async () => {
    await storeVerifiedPasskey(db, credential);
    sqlite.prepare("UPDATE users SET email_verified = 0 WHERE id = ?").run(credential.userId);
    expect(
      await recordVerifiedPasskeyAuthentication(db, {
        ...credential,
        previousCounter: 1,
        newCounter: 2,
      }),
    ).toBe(false);
  });

  it.each([-1, 1.5, NaN, Infinity, 0x100000000])(
    "rejects invalid counters (%s)",
    async (counter) => {
      await expect(storeVerifiedPasskey(db, { ...credential, counter })).rejects.toThrow();
      await expect(
        recordVerifiedPasskeyAuthentication(db, {
          ...credential,
          previousCounter: 0,
          newCounter: counter,
        }),
      ).rejects.toThrow();
    },
  );

  it("does not record a login for a deleted, banned or mismatched account", async () => {
    await storeVerifiedPasskey(db, credential);
    const input = { ...credential, previousCounter: 1, newCounter: 2 };
    expect(await recordVerifiedPasskeyAuthentication(db, { ...input, userId: "other-user" })).toBe(
      false,
    );
    sqlite.prepare("UPDATE users SET banned_at = '2026-11-07' WHERE id = ?").run(credential.userId);
    expect(await recordVerifiedPasskeyAuthentication(db, input)).toBe(false);
    sqlite.prepare("DELETE FROM users WHERE id = ?").run(credential.userId);
    expect(await findPasskeyCredential(db, credential)).toBeNull();
    expect(await recordVerifiedPasskeyAuthentication(db, input)).toBe(false);
  });

  it("cascades pending challenges and credentials when an account is deleted", async () => {
    const input = await binding();
    await storeVerifiedPasskey(db, credential);
    sqlite.prepare("DELETE FROM users WHERE id = ?").run(registration.userId);
    expect(await consumePasskeyChallenge(db, input)).toBeNull();
    expect(await findPasskeyCredential(db, credential)).toBeNull();
  });
});
