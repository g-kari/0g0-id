import type { ResourceServer } from "../types";

/**
 * RFC 8707 リソースインジケーターの対象レジストリ。
 *
 * アクセストークンの aud にできるのは、ここに登録された URI のみ。
 * 登録は管理者のみ（workers/id の /api/resources）が行い、認可フローは
 * findResourceServerByUri で「登録済みか」だけを検証する。
 */

export async function findResourceServerById(
  db: D1Database,
  id: string,
): Promise<ResourceServer | null> {
  return db.prepare("SELECT * FROM resource_servers WHERE id = ?").bind(id).first<ResourceServer>();
}

export async function findResourceServerByUri(
  db: D1Database,
  uri: string,
): Promise<ResourceServer | null> {
  return db
    .prepare("SELECT * FROM resource_servers WHERE uri = ?")
    .bind(uri)
    .first<ResourceServer>();
}

export async function listResourceServers(db: D1Database): Promise<ResourceServer[]> {
  const result = await db
    .prepare("SELECT * FROM resource_servers ORDER BY created_at ASC")
    .all<ResourceServer>();
  return result.results;
}

export async function createResourceServer(
  db: D1Database,
  params: {
    id: string;
    uri: string;
    name: string;
    allowedScopes: string;
    ownerUserId: string;
  },
): Promise<ResourceServer> {
  const resource = await db
    .prepare(
      `INSERT INTO resource_servers (id, uri, name, allowed_scopes, owner_user_id)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(params.id, params.uri, params.name, params.allowedScopes, params.ownerUserId)
    .first<ResourceServer>();
  if (!resource) throw new Error("Failed to create resource server");
  return resource;
}

export async function deleteResourceServer(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM resource_servers WHERE id = ?").bind(id).run();
}
