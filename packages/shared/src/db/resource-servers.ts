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
    /** 利用を許可するユーザーIDの JSON 配列（省略時は制限なし） */
    allowedSubjects?: string;
    ownerUserId: string;
  },
): Promise<ResourceServer> {
  const resource = await db
    .prepare(
      `INSERT INTO resource_servers (id, uri, name, allowed_scopes, allowed_subjects, owner_user_id)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      params.id,
      params.uri,
      params.name,
      params.allowedScopes,
      params.allowedSubjects ?? "[]",
      params.ownerUserId,
    )
    .first<ResourceServer>();
  if (!resource) throw new Error("Failed to create resource server");
  return resource;
}

export async function updateResourceServer(
  db: D1Database,
  id: string,
  params: {
    name: string;
    allowedScopes: string;
    allowedSubjects: string;
  },
): Promise<ResourceServer | null> {
  return db
    .prepare(
      `UPDATE resource_servers
       SET name = ?, allowed_scopes = ?, allowed_subjects = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?
       RETURNING *`,
    )
    .bind(params.name, params.allowedScopes, params.allowedSubjects, id)
    .first<ResourceServer>();
}

export async function deleteResourceServer(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM resource_servers WHERE id = ?").bind(id).run();
}
