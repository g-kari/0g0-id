/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  linkSocialLoginUser,
  upsertSocialLoginUser,
  unlinkSocialLoginProvider,
} from "./social-login-users";

function d1Adapter(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: SQLInputValue[]) {
          return {
            async first<T>(): Promise<T | null> {
              return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const discord = "123456789012345678";
const steam = "76561198000000000";

describe("social login users (real SQLite)", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    const dir = new URL("../../../../migrations/", import.meta.url);
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
    }
    sqlite.exec(
      readFileSync(
        new URL("../../../../docs/proposals/social-login-schema.sql", import.meta.url),
        "utf8",
      ),
    );
    // Exclude the migration-seeded system account from isolated user-count assertions.
    sqlite.exec("DELETE FROM users WHERE id = 'system-dcr-owner'");
    db = d1Adapter(sqlite);
  });
  afterEach(() => sqlite.close());

  function addTarget(id = firstId) {
    sqlite
      .prepare(`INSERT INTO users (id, google_sub, email, email_verified, name, picture, role)
      VALUES (?, ?, ?, 1, 'Original', 'original-picture', 'admin')`)
      .run(id, `google-${id}`, `${id}@example.com`);
  }

  it.each(["discord", "steam"] as const)(
    "creates an unverified %s user without subject/email leakage",
    async (provider) => {
      const sub = provider === "discord" ? discord : steam;
      const user = await upsertSocialLoginUser(db, {
        id: firstId,
        provider,
        sub,
        name: "Name",
        picture: null,
      });
      expect(user.id).toBe(firstId);
      expect(user.email).toBe(`${firstId}@${provider}.invalid`);
      expect(user.email).not.toContain(sub);
      expect(user.email_verified).toBe(0);
      expect(user.google_sub).toBeNull();
      expect(user.role).toBe("user");
      expect(sqlite.prepare(`SELECT ${provider}_sub AS sub FROM users`).get()!.sub).toBe(sub);
    },
  );

  it.each(["discord", "steam"] as const)(
    "updates only a known %s subject's profile, preserving verified email and role",
    async (provider) => {
      addTarget();
      const sub = provider === "discord" ? discord : steam;
      await linkSocialLoginUser(db, firstId, provider, sub);
      const user = await upsertSocialLoginUser(db, {
        id: secondId,
        provider,
        sub,
        name: "Updated",
        picture: "new-picture",
      });
      expect(user.id).toBe(firstId);
      expect(user.email).toBe(`${firstId}@example.com`);
      expect(user.email_verified).toBe(1);
      expect(user.role).toBe("admin");
      expect(user.google_sub).toBe(`google-${firstId}`);
      expect(user.name).toBe("Updated");
      expect(user.picture).toBe("new-picture");
      expect(sqlite.prepare("SELECT count(*) AS n FROM users").get()!.n).toBe(1);
    },
  );

  it("never implicitly links a different provider even when its numeric subject matches", async () => {
    const first = await upsertSocialLoginUser(db, {
      id: firstId,
      provider: "discord",
      sub: steam,
      name: "Same",
      picture: null,
    });
    const second = await upsertSocialLoginUser(db, {
      id: secondId,
      provider: "steam",
      sub: steam,
      name: "Same",
      picture: null,
    });
    expect(first.id).not.toBe(second.id);
    expect(sqlite.prepare("SELECT count(*) AS n FROM users").get()!.n).toBe(2);
  });

  it("never matches a placeholder email to an existing unrelated verified account", async () => {
    addTarget();
    sqlite
      .prepare("UPDATE users SET email = ? WHERE id = ?")
      .run(`${secondId}@discord.invalid`, firstId);
    await expect(
      upsertSocialLoginUser(db, {
        id: secondId,
        provider: "discord",
        sub: discord,
        name: "Other",
        picture: null,
      }),
    ).rejects.toThrow();
    expect(sqlite.prepare("SELECT discord_sub FROM users").get()!.discord_sub).toBeNull();
    expect(sqlite.prepare("SELECT count(*) AS n FROM users").get()!.n).toBe(1);
  });

  it.each(["discord", "steam"] as const)(
    "concurrent %s logins converge on exactly one account",
    async (provider) => {
      const sub = provider === "discord" ? discord : steam;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          upsertSocialLoginUser(db, {
            id: crypto.randomUUID(),
            provider,
            sub,
            name: "Profile",
            picture: null,
          }),
        ),
      );
      expect(new Set(results.map((user) => user.id)).size).toBe(1);
      expect(sqlite.prepare("SELECT count(*) AS n FROM users").get()!.n).toBe(1);
    },
  );

  it("does not alter banned users during login or linking", async () => {
    addTarget();
    await linkSocialLoginUser(db, firstId, "discord", discord);
    sqlite.prepare("UPDATE users SET banned_at = '2026-11-01' WHERE id = ?").run(firstId);
    const before = sqlite.prepare("SELECT * FROM users").get();
    await expect(
      upsertSocialLoginUser(db, {
        id: secondId,
        provider: "discord",
        sub: discord,
        name: "Overwrite",
        picture: null,
      }),
    ).rejects.toThrow("ACCOUNT_UNAVAILABLE");
    await expect(linkSocialLoginUser(db, firstId, "steam", steam)).rejects.toThrow(
      "ACCOUNT_UNAVAILABLE",
    );
    expect(sqlite.prepare("SELECT * FROM users").get()).toEqual(before);
  });

  it("links a subject once and permits an idempotent same-subject link without changing profile", async () => {
    addTarget();
    const first = await linkSocialLoginUser(db, firstId, "discord", discord);
    const second = await linkSocialLoginUser(db, firstId, "discord", discord);
    expect(second).toEqual(first);
    expect(first.email_verified).toBe(1);
    expect(first.name).toBe("Original");
    expect(first.picture).toBe("original-picture");
    expect(first.role).toBe("admin");
    expect(first.email).toBe(`${firstId}@example.com`);
  });

  it("rejects an occupied target column and an identity owned by another user", async () => {
    addTarget();
    addTarget(secondId);
    await linkSocialLoginUser(db, firstId, "discord", discord);
    await expect(linkSocialLoginUser(db, firstId, "discord", "999999999999999999")).rejects.toThrow(
      "PROVIDER_ALREADY_LINKED",
    );
    await expect(linkSocialLoginUser(db, secondId, "discord", discord)).rejects.toThrow(
      "PROVIDER_ALREADY_LINKED",
    );
    expect(
      sqlite.prepare("SELECT discord_sub FROM users WHERE id = ?").get(firstId)!.discord_sub,
    ).toBe(discord);
    expect(
      sqlite.prepare("SELECT discord_sub FROM users WHERE id = ?").get(secondId)!.discord_sub,
    ).toBeNull();
  });

  it("rejects deleted targets and does not create replacement users", async () => {
    addTarget();
    sqlite.prepare("DELETE FROM users WHERE id = ?").run(firstId);
    await expect(linkSocialLoginUser(db, firstId, "discord", discord)).rejects.toThrow(
      "ACCOUNT_UNAVAILABLE",
    );
    expect(sqlite.prepare("SELECT count(*) AS n FROM users").get()!.n).toBe(0);
  });

  it("serializes two users racing to link the same identity", async () => {
    addTarget();
    addTarget(secondId);
    const results = await Promise.allSettled([
      linkSocialLoginUser(db, firstId, "steam", steam),
      linkSocialLoginUser(db, secondId, "steam", steam),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason.message).toBe("PROVIDER_ALREADY_LINKED");
  });

  it("serializes different identities racing to occupy one target provider", async () => {
    addTarget();
    const results = await Promise.allSettled([
      linkSocialLoginUser(db, firstId, "discord", discord),
      linkSocialLoginUser(db, firstId, "discord", "999999999999999999"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason
        .message,
    ).toBe("PROVIDER_ALREADY_LINKED");
  });

  it("concurrent unlinks of the last two identities leave exactly one usable factor", async () => {
    addTarget();
    await linkSocialLoginUser(db, firstId, "discord", discord);
    const results = await Promise.all([
      unlinkSocialLoginProvider(db, firstId, "google"),
      unlinkSocialLoginProvider(db, firstId, "discord"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = sqlite
      .prepare("SELECT google_sub, discord_sub FROM users WHERE id = ?")
      .get(firstId)!;
    expect([row.google_sub, row.discord_sub].filter(Boolean)).toHaveLength(1);
  });

  it.each(["google", "line", "twitch", "github", "x", "discord", "steam"] as const)(
    "supports atomic unlink for %s",
    async (provider) => {
      addTarget();
      sqlite
        .prepare("UPDATE users SET steam_sub = ?, discord_sub = ? WHERE id = ?")
        .run(steam, discord, firstId);
      if (!["google", "steam", "discord"].includes(provider)) {
        sqlite
          .prepare(`UPDATE users SET ${provider}_sub = ? WHERE id = ?`)
          .run("legacy-provider-sub", firstId);
      }
      expect(await unlinkSocialLoginProvider(db, firstId, provider)).toBe(true);
      expect(await unlinkSocialLoginProvider(db, firstId, provider)).toBe(false);
      expect(
        sqlite.prepare(`SELECT ${provider}_sub AS sub FROM users WHERE id = ?`).get(firstId)!.sub,
      ).toBeNull();
    },
  );

  it("refuses last-factor, missing, null and banned account unlinks", async () => {
    addTarget();
    expect(await unlinkSocialLoginProvider(db, firstId, "google")).toBe(false);
    expect(await unlinkSocialLoginProvider(db, firstId, "discord")).toBe(false);
    expect(await unlinkSocialLoginProvider(db, secondId, "google")).toBe(false);
    await linkSocialLoginUser(db, firstId, "steam", steam);
    sqlite.prepare("UPDATE users SET banned_at = '2026-11-01' WHERE id = ?").run(firstId);
    expect(await unlinkSocialLoginProvider(db, firstId, "steam")).toBe(false);
  });

  it("does not retry an uncertain identity write", async () => {
    addTarget();
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
      linkSocialLoginUser({ prepare } as unknown as D1Database, firstId, "discord", discord),
    ).rejects.toThrow("lost response");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT discord_sub FROM users").get()!.discord_sub).toBe(discord);
  });

  it.each(["", "display-name", "123@example.com", "0", "18446744073709551616"])(
    "rejects non-stable Discord subject %s",
    async (sub) => {
      await expect(
        upsertSocialLoginUser(db, {
          id: firstId,
          provider: "discord",
          sub,
          name: "Name",
          picture: null,
        }),
      ).rejects.toThrow();
      await expect(linkSocialLoginUser(db, firstId, "discord", sub)).rejects.toThrow();
    },
  );
  it.each(["", "display-name", "123@example.com", "7656119800000000", "07656119800000000"])(
    "rejects invalid Steam subject %s",
    async (sub) => {
      await expect(
        upsertSocialLoginUser(db, {
          id: firstId,
          provider: "steam",
          sub,
          name: "Name",
          picture: null,
        }),
      ).rejects.toThrow();
    },
  );
});
