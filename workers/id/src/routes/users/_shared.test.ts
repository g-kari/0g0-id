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
    db = {
      prepare(sql: string) {
        return {
          bind(...values: SQLInputValue[]) {
            return {
              async first() {
                return sqlite.prepare(sql).get(...values) ?? null;
              },
              async run() {
                writes.push(sql);
                return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
              },
            };
          },
        };
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
