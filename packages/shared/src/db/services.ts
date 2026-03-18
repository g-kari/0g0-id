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
  await db
    .prepare(
      `INSERT INTO services (id, name, client_id, client_secret_hash, allowed_scopes, owner_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      params.name,
      params.clientId,
      params.clientSecretHash,
      params.allowedScopes,
      params.ownerUserId
    )
    .run();

  const service = await findServiceById(db, params.id);
  if (!service) throw new Error('Failed to create service');
  return service;
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
