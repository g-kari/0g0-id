import type { Service } from '../types';

// ─── インメモリ TTL キャッシュ ───────────────────────────────────────────────
// Cloudflare Workers の isolate はリクエスト間で再利用されるため、
// モジュールレベルの Map によるキャッシュが有効に機能する。

const CACHE_TTL_MS = 5 * 60 * 1000; // 5分

interface ServiceCacheEntry {
  service: Service;
  expiresAt: number;
}

/** client_id → Service のキャッシュ */
const byClientId = new Map<string, ServiceCacheEntry>();
/** service.id → client_id の逆引き（無効化用） */
const idToClientId = new Map<string, string>();

function cachePut(service: Service): void {
  byClientId.set(service.client_id, { service, expiresAt: Date.now() + CACHE_TTL_MS });
  idToClientId.set(service.id, service.client_id);
}

/** サービスの更新・削除・シークレットローテーション時にキャッシュを即時破棄する */
export function invalidateServiceCache(id: string): void {
  const clientId = idToClientId.get(id);
  if (clientId) {
    byClientId.delete(clientId);
    idToClientId.delete(id);
  }
}

// ─── DB アクセス関数 ─────────────────────────────────────────────────────────

export async function findServiceById(db: D1Database, id: string): Promise<Service | null> {
  return db.prepare('SELECT * FROM services WHERE id = ?').bind(id).first<Service>();
}

export async function findServiceByClientId(
  db: D1Database,
  clientId: string
): Promise<Service | null> {
  const now = Date.now();
  const cached = byClientId.get(clientId);
  if (cached && cached.expiresAt > now) {
    return cached.service;
  }

  const service = await db
    .prepare('SELECT * FROM services WHERE client_id = ?')
    .bind(clientId)
    .first<Service>();

  if (service) cachePut(service);
  return service;
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

export async function updateServiceFields(
  db: D1Database,
  id: string,
  fields: { name?: string; allowedScopes?: string }
): Promise<Service | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (fields.name !== undefined) {
    sets.push('name = ?');
    binds.push(fields.name);
  }
  if (fields.allowedScopes !== undefined) {
    sets.push('allowed_scopes = ?');
    binds.push(fields.allowedScopes);
  }

  if (sets.length === 0) return null;

  binds.push(id);
  const service = await db
    .prepare(
      `UPDATE services SET ${sets.join(', ')}, updated_at = datetime('now')
       WHERE id = ?
       RETURNING *`
    )
    .bind(...binds)
    .first<Service>();

  if (service) cachePut(service);
  else invalidateServiceCache(id);
  return service;
}





export async function deleteService(db: D1Database, id: string): Promise<void> {
  invalidateServiceCache(id);
  await db.prepare('DELETE FROM services WHERE id = ?').bind(id).run();
}

export interface ServiceListFilter {
  name?: string;
  limit?: number;
  offset?: number;
}

export async function listServices(db: D1Database, filter: ServiceListFilter = {}): Promise<Service[]> {
  const { name, limit = 50, offset = 0 } = filter;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (name) {
    conditions.push('name LIKE ?');
    params.push(`%${name}%`);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const result = await db
    .prepare(`SELECT * FROM services${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...params)
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

export async function listServicesByOwner(db: D1Database, userId: string): Promise<Service[]> {
  const result = await db
    .prepare('SELECT * FROM services WHERE owner_user_id = ? ORDER BY created_at DESC')
    .bind(userId)
    .all<Service>();
  return result.results;
}

export async function countServices(db: D1Database, filter: { name?: string } = {}): Promise<number> {
  const { name } = filter;

  const params: unknown[] = [];
  let query = 'SELECT COUNT(*) as count FROM services';

  if (name) {
    query += ' WHERE name LIKE ?';
    params.push(`%${name}%`);
  }

  const stmt = db.prepare(query);
  const result = params.length > 0
    ? await stmt.bind(...params).first<{ count: number }>()
    : await stmt.first<{ count: number }>();
  return result?.count ?? 0;
}

export async function rotateClientSecret(
  db: D1Database,
  id: string,
  newClientSecretHash: string
): Promise<Service | null> {
  // シークレットローテーション: 旧キャッシュを即時破棄してから更新
  invalidateServiceCache(id);
  const service = await db
    .prepare(
      `UPDATE services SET client_secret_hash = ?, updated_at = datetime('now')
       WHERE id = ?
       RETURNING *`
    )
    .bind(newClientSecretHash, id)
    .first<Service>();

  if (service) cachePut(service);
  return service;
}

export async function transferServiceOwnership(
  db: D1Database,
  id: string,
  newOwnerUserId: string
): Promise<Service | null> {
  const service = await db
    .prepare(
      `UPDATE services SET owner_user_id = ?, updated_at = datetime('now')
       WHERE id = ?
       RETURNING *`
    )
    .bind(newOwnerUserId, id)
    .first<Service>();

  if (service) cachePut(service);
  else invalidateServiceCache(id);
  return service;
}
