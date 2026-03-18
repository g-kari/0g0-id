import type { Service } from '../types';

export async function findServiceById(db: D1Database, id: string): Promise<Service | null> {
  return db.prepare('SELECT * FROM services WHERE id = ?').bind(id).first<Service>();
}

export async function findServiceByClientId(
  db: D1Database,
  clientId: string
): Promise<Service | null> {
  return db.prepare('SELECT * FROM services WHERE client_id = ?').bind(clientId).first<Service>();
}

export async function createService(
  db: D1Database,
  params: {
    id: string;
    name: string;
    clientId: string;
    clientSecretHash: string;
    allowedScopes: string;
    ownerUserId: string;
  }
): Promise<Service> {
  const service = await db
    .prepare(
      `INSERT INTO services (id, name, client_id, client_secret_hash, allowed_scopes, owner_user_id)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      params.id,
      params.name,
      params.clientId,
      params.clientSecretHash,
      params.allowedScopes,
      params.ownerUserId
    )
    .first<Service>();
  if (!service) throw new Error('Failed to create service');
  return service;
}

export async function updateServiceAllowedScopes(
  db: D1Database,
  id: string,
  allowedScopes: string
): Promise<Service | null> {
  return db
    .prepare(
      `UPDATE services SET allowed_scopes = ?, updated_at = datetime('now')
       WHERE id = ?
       RETURNING *`
    )
    .bind(allowedScopes, id)
    .first<Service>();
}

export async function deleteService(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM services WHERE id = ?').bind(id).run();
}

export async function listServices(db: D1Database): Promise<Service[]> {
  const result = await db
    .prepare('SELECT * FROM services ORDER BY created_at DESC')
    .all<Service>();
  return result.results;
}

export async function countServicesByOwner(db: D1Database, userId: string): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM services WHERE owner_user_id = ?')
    .bind(userId)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function countServices(db: D1Database): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM services')
    .first<{ count: number }>();
  return result?.count ?? 0;
}
