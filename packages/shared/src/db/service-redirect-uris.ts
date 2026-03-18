import type { ServiceRedirectUri } from '../types';

export async function listRedirectUris(
  db: D1Database,
  serviceId: string
): Promise<ServiceRedirectUri[]> {
  const result = await db
    .prepare('SELECT * FROM service_redirect_uris WHERE service_id = ? ORDER BY created_at ASC')
    .bind(serviceId)
    .all<ServiceRedirectUri>();
  return result.results;
}

export async function addRedirectUri(
  db: D1Database,
  params: { id: string; serviceId: string; uri: string }
): Promise<ServiceRedirectUri> {
  const uri = await db
    .prepare(
      'INSERT INTO service_redirect_uris (id, service_id, uri) VALUES (?, ?, ?) RETURNING *'
    )
    .bind(params.id, params.serviceId, params.uri)
    .first<ServiceRedirectUri>();
  if (!uri) throw new Error('Failed to add redirect URI');
  return uri;
}

export async function deleteRedirectUri(
  db: D1Database,
  id: string,
  serviceId: string
): Promise<void> {
  await db
    .prepare('DELETE FROM service_redirect_uris WHERE id = ? AND service_id = ?')
    .bind(id, serviceId)
    .run();
}

export async function isValidRedirectUri(
  db: D1Database,
  serviceId: string,
  uri: string
): Promise<boolean> {
  const result = await db
    .prepare(
      'SELECT id FROM service_redirect_uris WHERE service_id = ? AND uri = ?'
    )
    .bind(serviceId, uri)
    .first();
  return result !== null;
}
