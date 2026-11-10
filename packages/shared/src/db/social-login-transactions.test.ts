/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  cleanupSocialLoginTransactions,
  consumeSocialLoginTransaction,
  consumeSocialLoginLinkToken,
  consumeSteamLoginNonce,
  issueSocialLoginTransaction,
  socialLoginSchemaReady,
} from "./social-login-transactions";

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

const proposal = readFileSync(
  new URL("../../../../docs/proposals/social-login-schema.sql", import.meta.url),
  "utf8",
);
const binding = {
  state: "A".repeat(43),
  browserBinding: "B".repeat(43),
  statePayload: '{"provider":"discord","codeVerifier":"private-verifier"}',
  provider: "discord" as const,
  idpOrigin: "https://id.0g0.xyz",
};
const nonceHash = "a".repeat(64);

describe("social login storage (real SQLite)", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  let now: number;
  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    sqlite.exec(proposal);
    db = d1Adapter(sqlite);
    now = Number(sqlite.prepare("SELECT unixepoch() AS now").get()!.now);
  });
  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });

  it("stores hashes only and issues expiry from database time despite application clock skew", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01"));
    await issueSocialLoginTransaction(db, binding);
    const row = sqlite.prepare("SELECT * FROM social_login_transactions").get()!;
    for (const key of ["state_hash", "browser_binding_hash", "state_payload_hash"]) {
      expect(row[key]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(row)).not.toContain(binding.state);
    expect(JSON.stringify(row)).not.toContain(binding.browserBinding);
    expect(JSON.stringify(row)).not.toContain("private-verifier");
    expect(Number(row.expires_at)).toBeGreaterThanOrEqual(now + 600);
    expect(Number(row.expires_at)).toBeLessThanOrEqual(now + 602);
    expect(await consumeSocialLoginTransaction(db, binding)).toBe(true);
    expect(await consumeSocialLoginTransaction(db, binding)).toBe(false);
  });

  it("rejects every mismatched binding without consuming the valid transaction", async () => {
    await issueSocialLoginTransaction(db, binding);
    for (const change of [
      { state: "C".repeat(43) },
      { browserBinding: "C".repeat(43) },
      { statePayload: binding.statePayload + " " },
      { provider: "steam" as const },
      { idpOrigin: "https://else.0g0.xyz" },
      { idpOrigin: "https://id.0g0.xyz:8443" },
    ])
      expect(await consumeSocialLoginTransaction(db, { ...binding, ...change })).toBe(false);
    expect(await consumeSocialLoginTransaction(db, binding)).toBe(true);
  });

  it("allows exactly one racing transaction consumer", async () => {
    await issueSocialLoginTransaction(db, binding);
    expect(
      (
        await Promise.all(
          Array.from({ length: 8 }, () => consumeSocialLoginTransaction(db, binding)),
        )
      ).filter(Boolean),
    ).toHaveLength(1);
  });

  it("does not overwrite an already issued state", async () => {
    await issueSocialLoginTransaction(db, binding);
    await expect(
      issueSocialLoginTransaction(db, { ...binding, provider: "steam" }),
    ).rejects.toThrow();
    expect(await consumeSocialLoginTransaction(db, binding)).toBe(true);
  });

  it.each(["state", "browserBinding"] as const)("rejects malformed %s", async (key) => {
    for (const value of ["", "x".repeat(42), "x".repeat(44), "!".repeat(43)]) {
      await expect(issueSocialLoginTransaction(db, { ...binding, [key]: value })).rejects.toThrow();
      await expect(
        consumeSocialLoginTransaction(db, { ...binding, [key]: value }),
      ).rejects.toThrow();
    }
  });

  it.each([
    "http://id.0g0.xyz",
    "https://id.0g0.xyz/",
    "https://id.0g0.xyz/a",
    "https://user:pw@id.0g0.xyz",
    "https://id.0g0.xyz?x=1",
    "bad",
  ])("rejects noncanonical origins %s", async (idpOrigin) => {
    await expect(issueSocialLoginTransaction(db, { ...binding, idpOrigin })).rejects.toThrow();
  });

  it("rejects exact-boundary expired transactions using DB time and cleans only expired rows", async () => {
    await issueSocialLoginTransaction(db, binding);
    sqlite.exec("UPDATE social_login_transactions SET expires_at = unixepoch()");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01"));
    expect(await consumeSocialLoginTransaction(db, binding)).toBe(false);
    await issueSocialLoginTransaction(db, { ...binding, state: "C".repeat(43) });
    sqlite.prepare("INSERT INTO steam_login_nonces VALUES (?, unixepoch())").run(nonceHash);
    expect(await consumeSteamLoginNonce(db, "b".repeat(64), (now + 600) * 1000)).toBe(true);
    await cleanupSocialLoginTransactions(db);
    expect(sqlite.prepare("SELECT count(*) AS n FROM social_login_transactions").get()!.n).toBe(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM steam_login_nonces").get()!.n).toBe(1);
  });

  it("accepts a transaction immediately before DB expiry", async () => {
    await issueSocialLoginTransaction(db, binding);
    sqlite.exec("UPDATE social_login_transactions SET expires_at = unixepoch() + 1");
    expect(await consumeSocialLoginTransaction(db, binding)).toBe(true);
  });

  it("atomically rejects nonce replay and racing duplicate claims", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => consumeSteamLoginNonce(db, nonceHash, (now + 600) * 1000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await consumeSteamLoginNonce(db, nonceHash, (now + 900) * 1000)).toBe(false);
    expect(sqlite.prepare("SELECT expires_at FROM steam_login_nonces").get()!.expires_at).toBe(
      now + 600,
    );
  });

  it("rejects stale and exact-boundary nonce expiry despite an application clock in the past", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01"));
    for (const expiry of [(now - 1) * 1000, now * 1000, now * 1000 + 999]) {
      expect(await consumeSteamLoginNonce(db, nonceHash, expiry)).toBe(false);
    }
    expect(sqlite.prepare("SELECT count(*) AS n FROM steam_login_nonces").get()!.n).toBe(0);
  });

  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects malformed nonce expiry %s",
    async (expiry) => {
      await expect(consumeSteamLoginNonce(db, nonceHash, expiry)).rejects.toThrow();
    },
  );
  it.each(["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)])(
    "rejects malformed nonce hash %s",
    async (hash) => {
      await expect(consumeSteamLoginNonce(db, hash, (now + 600) * 1000)).rejects.toThrow();
    },
  );

  it.each(["discord_sub", "steam_sub"])("requires the provider column %s", async (column) => {
    expect(await socialLoginSchemaReady(db)).toBe(true);
    sqlite.exec(`DROP INDEX idx_users_${column}; ALTER TABLE users DROP COLUMN ${column}`);
    expect(await socialLoginSchemaReady(db)).toBe(false);
  });
  it.each(["social_login_transactions", "steam_login_nonces", "social_login_link_nonces"])(
    "fails readiness for missing %s",
    async (table) => {
      sqlite.exec(`DROP TABLE ${table}`);
      expect(await socialLoginSchemaReady(db)).toBe(false);
    },
  );

  it("claims a link JTI once, stores only its digest, and serializes racing consumers", async () => {
    const jti = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => consumeSocialLoginLinkToken(db, jti, (now + 120) * 1000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = sqlite.prepare("SELECT * FROM social_login_link_nonces").get()!;
    expect(row.jti_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(jti);
    expect(row.expires_at).toBe(now + 120);
    expect(await consumeSocialLoginLinkToken(db, jti.toUpperCase(), (now + 120) * 1000)).toBe(
      false,
    );
  });

  it("rejects expired or overly long link tokens using database time despite clock skew", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01"));
    for (const expiry of [(now - 1) * 1000, now * 1000, (now + 300) * 1000]) {
      expect(await consumeSocialLoginLinkToken(db, crypto.randomUUID(), expiry)).toBe(false);
    }
    expect(sqlite.prepare("SELECT count(*) AS n FROM social_login_link_nonces").get()!.n).toBe(0);
  });

  it("cleans expired link claims without deleting live claims", async () => {
    const jti = crypto.randomUUID();
    expect(await consumeSocialLoginLinkToken(db, jti, (now + 100) * 1000)).toBe(true);
    sqlite
      .prepare("INSERT INTO social_login_link_nonces VALUES (?, unixepoch())")
      .run("c".repeat(64));
    await cleanupSocialLoginTransactions(db);
    expect(sqlite.prepare("SELECT count(*) AS n FROM social_login_link_nonces").get()!.n).toBe(1);
    expect(await consumeSocialLoginLinkToken(db, jti, (now + 100) * 1000)).toBe(false);
  });

  it.each(["", "not-a-uuid", "a".repeat(64), "00000000-0000-0000-0000-000000000000"])(
    "rejects malformed link JTI %s",
    async (jti) => {
      await expect(consumeSocialLoginLinkToken(db, jti, (now + 100) * 1000)).rejects.toThrow();
    },
  );
  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects malformed link expiry %s",
    async (expiry) => {
      await expect(consumeSocialLoginLinkToken(db, crypto.randomUUID(), expiry)).rejects.toThrow();
    },
  );

  it("does not retry a link claim after an uncertain response", async () => {
    const jti = crypto.randomUUID();
    const prepare = vi.fn((sql: string) => ({
      bind(...values: SQLInputValue[]) {
        return {
          async first() {
            sqlite.prepare(sql).get(...values);
            throw new Error("lost response");
          },
        };
      },
    }));
    await expect(
      consumeSocialLoginLinkToken({ prepare } as unknown as D1Database, jti, (now + 100) * 1000),
    ).rejects.toThrow("lost response");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await consumeSocialLoginLinkToken(db, jti, (now + 100) * 1000)).toBe(false);
  });

  it("fails closed on database errors and never retries a consume with uncertain execution", async () => {
    await issueSocialLoginTransaction(db, binding);
    const realPrepare = db.prepare.bind(db);
    const prepare = vi.fn((sql: string) => {
      const statement = realPrepare(sql);
      return {
        bind(...values: SQLInputValue[]) {
          const bound = statement.bind(...values);
          return {
            async first() {
              await bound.first();
              throw new Error("lost response");
            },
          };
        },
      };
    });
    const broken = { prepare } as unknown as D1Database;
    await expect(consumeSocialLoginTransaction(broken, binding)).rejects.toThrow("lost response");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await consumeSocialLoginTransaction(db, binding)).toBe(false);
    expect(await socialLoginSchemaReady(broken)).toBe(false);
  });
});

it("proposal preserves populated real migration schema and existing provider identities", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const dir = new URL("../../../../migrations/", import.meta.url);
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
    }
    sqlite.exec(`INSERT INTO users (id, google_sub, email, name, line_sub, twitch_sub, github_sub, x_sub)
      VALUES ('existing', 'google-id', 'existing@example.com', 'Existing', 'line-id', 'twitch-id', 'github-id', 'x-id');`);
    const before = sqlite.prepare("SELECT * FROM users WHERE id = 'existing'").get()!;
    sqlite.exec(proposal);
    const after = sqlite.prepare("SELECT * FROM users WHERE id = 'existing'").get()!;
    expect(after).toEqual({ ...before, discord_sub: null, steam_sub: null });
    sqlite.exec(`INSERT INTO users (id, email, name) VALUES ('second', 'second@example.com', 'Second');
      UPDATE users SET discord_sub = 'discord-id', steam_sub = 'steam-id' WHERE id = 'existing';`);
    for (const [column, value] of [
      ["discord_sub", "discord-id"],
      ["steam_sub", "steam-id"],
    ]) {
      expect(() =>
        sqlite.prepare(`UPDATE users SET ${column} = ? WHERE id = 'second'`).run(value),
      ).toThrow();
    }
    expect(
      sqlite
        .prepare(
          "SELECT google_sub, line_sub, twitch_sub, github_sub, x_sub FROM users WHERE id = 'existing'",
        )
        .get(),
    ).toEqual({
      google_sub: "google-id",
      line_sub: "line-id",
      twitch_sub: "twitch-id",
      github_sub: "github-id",
      x_sub: "x-id",
    });
  } finally {
    sqlite.close();
  }
});
