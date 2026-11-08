/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { performUserDeletion } from "./_shared";
import { INTERNAL_OPENAPI } from "../openapi/internal-spec";

describe("performUserDeletion with real migrations and foreign keys", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  let writes: string[];
  let injectResourceAfterPrecheck: boolean;
  let injectServiceAfterPrecheck: boolean;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    const migrations = fileURLToPath(new NodeURL("../../../../../migrations/", import.meta.url));
    for (const file of readdirSync(migrations)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      sqlite.exec(readFileSync(`${migrations}/${file}`, "utf8"));
    }
    writes = [];
    injectResourceAfterPrecheck = false;
    injectServiceAfterPrecheck = false;
    db = {
      prepare(sql: string) {
        return {
          bind(...values: SQLInputValue[]) {
            return {
              async first() {
                const result = sqlite.prepare(sql).get(...values) ?? null;
                if (
                  injectResourceAfterPrecheck &&
                  sql.includes("COUNT(*) as count FROM resource_servers")
                ) {
                  injectResourceAfterPrecheck = false;
                  sqlite
                    .prepare(
                      "INSERT INTO resource_servers (id, uri, name, owner_user_id) VALUES (?, ?, ?, ?)",
                    )
                    .run(
                      "racing-resource",
                      "https://racing.example.invalid",
                      "Racing resource",
                      "fixture-user",
                    );
                }
                if (injectServiceAfterPrecheck && sql.includes("COUNT(*) as count FROM services")) {
                  injectServiceAfterPrecheck = false;
                  sqlite
                    .prepare(
                      "INSERT INTO services (id, name, client_id, client_secret_hash, owner_user_id) VALUES (?, ?, ?, ?, ?)",
                    )
                    .run(
                      "racing-service",
                      "Racing service",
                      "racing-client",
                      "synthetic-hash",
                      "fixture-user",
                    );
                }
                return result;
              },
              async run() {
                writes.push(sql);
                return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
              },
            };
          },
        };
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        sqlite.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    } as unknown as D1Database;
    for (const id of ["fixture-user", "other-user"]) {
      sqlite
        .prepare("INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)")
        .run(id, `sub-${id}`, `${id}@example.invalid`, "Synthetic fixture");
    }
    sqlite.exec(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at)
        VALUES ('fixture-token', 'fixture-user', 'synthetic-token-hash', 'fixture-family', '2999-01-01');
      INSERT INTO bff_sessions (id, user_id, created_at, expires_at, bff_origin)
        VALUES ('fixture-session', 'fixture-user', 1, 9999999999, 'https://bff.example.invalid');
      INSERT INTO mcp_sessions (id, user_id, created_at, last_active_at)
        VALUES ('fixture-mcp', 'fixture-user', 1, 1);
    `);
  });

  afterEach(() => sqlite.close());

  function addResource(owner: string) {
    sqlite
      .prepare("INSERT INTO resource_servers (id, uri, name, owner_user_id) VALUES (?, ?, ?, ?)")
      .run(`resource-${owner}`, `https://${owner}.example.invalid`, "Synthetic resource", owner);
  }

  it("reproduces the restricted foreign key without deleting any real account", () => {
    addResource("fixture-user");
    expect(() => sqlite.prepare("DELETE FROM users WHERE id = ?").run("fixture-user")).toThrow(
      "FOREIGN KEY constraint failed",
    );
  });

  it("explicitly removes auth codes when the deployed FK is NO ACTION", async () => {
    sqlite.exec(`
      DROP TABLE auth_codes;
      CREATE TABLE auth_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
        code_hash TEXT UNIQUE NOT NULL,
        redirect_to TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resource TEXT
      );
    `);
    sqlite
      .prepare(
        "INSERT INTO auth_codes (id, user_id, code_hash, redirect_to, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "fixture-code",
        "fixture-user",
        "synthetic-code-hash",
        "https://client.example.invalid/cb",
        "2999-01-01",
      );
    sqlite
      .prepare(
        "INSERT INTO auth_codes (id, user_id, code_hash, redirect_to, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "other-code",
        "other-user",
        "other-synthetic-hash",
        "https://other.example.invalid/cb",
        "2999-01-01",
      );

    await expect(performUserDeletion(db, "fixture-user")).resolves.toBeNull();
    expect(sqlite.prepare("SELECT id FROM users WHERE id = 'fixture-user'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_codes").get()?.count).toBe(1);
    expect(sqlite.prepare("SELECT user_id FROM auth_codes").get()?.user_id).toBe("other-user");
  });

  it("rolls back auth-code and session cleanup when an owner appears after precheck", async () => {
    sqlite.exec(`
      DROP TABLE auth_codes;
      CREATE TABLE auth_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
        code_hash TEXT UNIQUE NOT NULL,
        redirect_to TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resource TEXT
      );
    `);
    sqlite
      .prepare(
        "INSERT INTO auth_codes (id, user_id, code_hash, redirect_to, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "fixture-code",
        "fixture-user",
        "synthetic-code-hash",
        "https://client.example.invalid/cb",
        "2999-01-01",
      );
    injectResourceAfterPrecheck = true;

    const error = await performUserDeletion(db, "fixture-user");
    expect(error?.code).toBe("CONFLICT");
    expect(error?.message).toContain("1 resource server(s)");
    expect(sqlite.prepare("SELECT id FROM users WHERE id = 'fixture-user'").get()).toBeDefined();
    expect(
      sqlite.prepare("SELECT id FROM resource_servers WHERE id = 'racing-resource'").get(),
    ).toBeDefined();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_codes").get()?.count).toBe(1);
    expect(sqlite.prepare("SELECT revoked_at FROM refresh_tokens").get()?.revoked_at).toBeNull();
    expect(sqlite.prepare("SELECT revoked_at FROM bff_sessions").get()?.revoked_at).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mcp_sessions").get()?.count).toBe(1);
  });

  it("rolls back dependent cleanup and returns conflict when a service owner appears after precheck", async () => {
    sqlite
      .prepare(
        "INSERT INTO auth_codes (id, user_id, code_hash, redirect_to, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "fixture-code",
        "fixture-user",
        "synthetic-code-hash",
        "https://client.example.invalid/cb",
        "2999-01-01",
      );
    injectServiceAfterPrecheck = true;

    const error = await performUserDeletion(db, "fixture-user");
    expect(error?.code).toBe("CONFLICT");
    expect(error?.message).toContain("1 service(s)");
    expect(sqlite.prepare("SELECT id FROM users WHERE id = 'fixture-user'").get()).toBeDefined();
    expect(
      sqlite.prepare("SELECT id FROM services WHERE id = 'racing-service'").get(),
    ).toBeDefined();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_codes").get()?.count).toBe(1);
    expect(sqlite.prepare("SELECT revoked_at FROM refresh_tokens").get()?.revoked_at).toBeNull();
    expect(sqlite.prepare("SELECT revoked_at FROM bff_sessions").get()?.revoked_at).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mcp_sessions").get()?.count).toBe(1);
  });

  it("rethrows unrelated FK failures and rolls back all cleanup", async () => {
    sqlite.exec(`
      CREATE TABLE unrelated_user_refs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE NO ACTION
      );
      INSERT INTO unrelated_user_refs (id, user_id) VALUES ('fixture-ref', 'fixture-user');
      INSERT INTO auth_codes (id, user_id, code_hash, redirect_to, expires_at)
        VALUES ('fixture-code', 'fixture-user', 'synthetic-code-hash', 'https://client.example.invalid/cb', '2999-01-01');
    `);

    await expect(performUserDeletion(db, "fixture-user")).rejects.toThrow(
      "FOREIGN KEY constraint failed",
    );
    expect(sqlite.prepare("SELECT id FROM users WHERE id = 'fixture-user'").get()).toBeDefined();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM unrelated_user_refs").get()?.count).toBe(
      1,
    );
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_codes").get()?.count).toBe(1);
    expect(sqlite.prepare("SELECT revoked_at FROM refresh_tokens").get()?.revoked_at).toBeNull();
    expect(sqlite.prepare("SELECT revoked_at FROM bff_sessions").get()?.revoked_at).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mcp_sessions").get()?.count).toBe(1);
  });

  it("returns a conflict before revoking tokens or sessions for a resource owner", async () => {
    addResource("fixture-user");
    const error = await performUserDeletion(db, "fixture-user");
    expect(error?.code).toBe("CONFLICT");
    expect(error?.message).toContain("1 resource server(s)");
    expect(writes).toEqual([]);
    expect(sqlite.prepare("SELECT revoked_at FROM refresh_tokens").get()?.revoked_at).toBeNull();
    expect(sqlite.prepare("SELECT revoked_at FROM bff_sessions").get()?.revoked_at).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mcp_sessions").get()?.count).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM resource_servers").get()?.count).toBe(1);
    expect(sqlite.prepare("SELECT id FROM users WHERE id = 'fixture-user'").get()).toBeDefined();
  });

  it("preserves the existing service-owner conflict before any writes", async () => {
    sqlite.exec(`INSERT INTO services (id, name, client_id, client_secret_hash, owner_user_id)
      VALUES ('fixture-service', 'Synthetic service', 'fixture-client', 'synthetic-hash', 'fixture-user')`);
    expect((await performUserDeletion(db, "fixture-user"))?.message).toContain("1 service(s)");
    expect(writes).toEqual([]);
  });

  it("deletes a non-owner and cascades sessions without touching another owner's resource", async () => {
    addResource("other-user");
    expect(await performUserDeletion(db, "fixture-user")).toBeNull();
    expect(sqlite.prepare("SELECT id FROM users WHERE id = 'fixture-user'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM refresh_tokens").get()?.count).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM bff_sessions").get()?.count).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mcp_sessions").get()?.count).toBe(0);
    expect(sqlite.prepare("SELECT owner_user_id FROM resource_servers").get()?.owner_user_id).toBe(
      "other-user",
    );
  });
  it("documents resource-owner conflicts for self and admin deletion", () => {
    for (const path of ["/api/users/me", "/api/users/{id}"] as const) {
      const operation = INTERNAL_OPENAPI.paths[path].delete;
      expect(operation.security).toEqual([{ BearerAuth: [] }]);
      expect(operation.responses["204"]).toBeDefined();
      expect(operation.responses["409"].description).toContain("リソースサーバー");
    }
    const selfDelete = INTERNAL_OPENAPI.paths["/api/users/me"].delete;
    expect(selfDelete.responses["401"].description).toContain("BAN済み");
    expect(selfDelete.responses["403"].description).not.toContain("ACCOUNT_BANNED");
    expect(selfDelete.description).toContain("Originヘッダー");
    expect(selfDelete.description).not.toContain("Referer");
  });
});
