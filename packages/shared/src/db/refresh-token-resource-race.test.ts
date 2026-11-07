import { describe, it, expect } from "vite-plus/test";
import { createRefreshToken } from "./refresh-tokens";
import {
  createResourceServer,
  findResourceServerByUri,
  deleteResourceServerWithTokenRevocation,
} from "./resource-servers";
import type { ResourceServer } from "../types";

/**
 * resource 削除と refresh 発行の競合を、状態を持つフェイク D1 で再現する。
 *
 * モックではなく実際の SQL 文の意味（INSERT ... SELECT ... WHERE EXISTS、
 * 失効 UPDATE、DELETE、batch）を最小限シミュレートし、
 * 「検証通過後に削除が割り込んでも後継トークンが作られない」
 * 「同 URI を再登録しても旧世代の grant が復活しない」を固定する。
 */

const RESOURCE_URI = "https://dots-events.0g0.xyz/mcp";

interface TokenRow {
  id: string;
  resource: string | null;
  resource_server_id: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

class FakeStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.db.executeFirst(this.sql, this.args) as T | null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return this.db.executeRun(this.sql, this.args);
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }
}

class FakeD1 {
  readonly resourceServers: ResourceServer[] = [];
  readonly refreshTokens: TokenRow[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<{ meta: { changes: number } }[]> {
    const results: { meta: { changes: number } }[] = [];
    for (const stmt of statements) {
      results.push(await stmt.run());
    }
    return results;
  }

  executeFirst(sql: string, args: unknown[]): unknown {
    if (sql.includes("INSERT INTO resource_servers")) {
      const [id, uri, name, allowedScopes, allowedSubjects, ownerUserId] = args as string[];
      const row: ResourceServer = {
        id: id!,
        uri: uri!,
        name: name!,
        allowed_scopes: allowedScopes!,
        allowed_subjects: allowedSubjects!,
        owner_user_id: ownerUserId!,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
      this.resourceServers.push(row);
      return row;
    }
    if (sql.includes("SELECT * FROM resource_servers WHERE uri = ?")) {
      return this.resourceServers.find((r) => r.uri === args[0]) ?? null;
    }
    throw new Error(`FakeD1: unsupported first() SQL: ${sql}`);
  }

  executeRun(sql: string, args: unknown[]): { meta: { changes: number } } {
    if (sql.includes("INSERT INTO refresh_tokens")) {
      const [id, , , , , , , , resource, resourceServerId, guardId] = args as (string | null)[];
      if (sql.includes("WHERE EXISTS")) {
        // 世代ガード: 対象の resource_servers 行が存在する間だけ挿入できる
        if (!this.resourceServers.some((r) => r.id === guardId)) {
          return { meta: { changes: 0 } };
        }
      }
      this.refreshTokens.push({
        id: id!,
        resource: resource ?? null,
        resource_server_id: resourceServerId ?? null,
        revoked_at: null,
        revoked_reason: null,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE refresh_tokens") && sql.includes("WHERE resource = ?")) {
      const [reason, uri] = args as string[];
      let changes = 0;
      for (const token of this.refreshTokens) {
        if (token.resource === uri && token.revoked_at === null) {
          token.revoked_at = "2026-01-02T00:00:00Z";
          token.revoked_reason = reason!;
          changes++;
        }
      }
      return { meta: { changes } };
    }
    if (sql.includes("DELETE FROM resource_servers WHERE id = ?")) {
      const index = this.resourceServers.findIndex((r) => r.id === args[0]);
      if (index >= 0) this.resourceServers.splice(index, 1);
      return { meta: { changes: index >= 0 ? 1 : 0 } };
    }
    throw new Error(`FakeD1: unsupported run() SQL: ${sql}`);
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }

  liveTokensFor(resourceUri: string): TokenRow[] {
    return this.refreshTokens.filter((t) => t.resource === resourceUri && t.revoked_at === null);
  }
}

async function seedResource(db: FakeD1, id: string): Promise<ResourceServer> {
  return createResourceServer(db.asD1(), {
    id,
    uri: RESOURCE_URI,
    name: "dots-events",
    allowedScopes: '["events:read"]',
    allowedSubjects: "[]",
    ownerUserId: "admin-1",
  });
}

function successorParams(id: string, resourceServerId: string) {
  return {
    id,
    userId: "user-1",
    serviceId: "svc-1",
    tokenHash: `hash-${id}`,
    familyId: "family-1",
    expiresAt: "2026-12-31T23:59:59Z",
    resource: RESOURCE_URI,
    resourceServerId,
  };
}

describe("resource 削除と refresh 発行の競合", () => {
  it("検証通過後に削除が割り込むと、後継トークンは作られない", async () => {
    const db = new FakeD1();
    await seedResource(db, "rs-gen-1");

    // 既存 grant のトークン（削除前は有効）
    const issued = await createRefreshToken(db.asD1(), successorParams("tok-1", "rs-gen-1"));
    expect(issued).toBe(true);

    // refresh 側: 登録の検証が通過した時点を再現
    const validated = await findResourceServerByUri(db.asD1(), RESOURCE_URI);
    expect(validated?.id).toBe("rs-gen-1");

    // 管理者: 検証と発行の間に削除が割り込む（失効＋削除は原子的）
    const revokedCount = await deleteResourceServerWithTokenRevocation(db.asD1(), {
      id: "rs-gen-1",
      uri: RESOURCE_URI,
    });
    expect(revokedCount).toBe(1);
    expect(await findResourceServerByUri(db.asD1(), RESOURCE_URI)).toBeNull();

    // refresh 側: 後継トークンの作成は世代ガードで抑止される
    const successorCreated = await createRefreshToken(
      db.asD1(),
      successorParams("tok-2", "rs-gen-1"),
    );
    expect(successorCreated).toBe(false);

    // 削除完了後に有効なトークンは残っていない
    expect(db.liveTokensFor(RESOURCE_URI)).toHaveLength(0);
    expect(db.refreshTokens.find((t) => t.id === "tok-1")?.revoked_reason).toBe("resource_delete");
  });

  it("削除→同 URI 再登録でも、旧世代の grant は復活しない", async () => {
    const db = new FakeD1();
    await seedResource(db, "rs-gen-1");
    await createRefreshToken(db.asD1(), successorParams("tok-1", "rs-gen-1"));

    await deleteResourceServerWithTokenRevocation(db.asD1(), {
      id: "rs-gen-1",
      uri: RESOURCE_URI,
    });

    // 同じ URI を再登録（新しい行 = 新しい世代）
    await seedResource(db, "rs-gen-2");
    const current = await findResourceServerByUri(db.asD1(), RESOURCE_URI);
    expect(current?.id).toBe("rs-gen-2");

    // 旧世代に束縛した後継トークンは再登録後も作れない
    const oldGeneration = await createRefreshToken(db.asD1(), successorParams("tok-2", "rs-gen-1"));
    expect(oldGeneration).toBe(false);

    // 旧トークンは失効したまま（再登録で復活しない）
    expect(db.refreshTokens.find((t) => t.id === "tok-1")?.revoked_at).not.toBeNull();
    expect(db.liveTokensFor(RESOURCE_URI)).toHaveLength(0);

    // 新世代の grant は通常どおり作れる
    const newGeneration = await createRefreshToken(db.asD1(), successorParams("tok-3", "rs-gen-2"));
    expect(newGeneration).toBe(true);
    expect(db.liveTokensFor(RESOURCE_URI)).toHaveLength(1);
  });
});
