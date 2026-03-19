import type { RefreshToken, User } from '../types';

export async function findRefreshTokenByHash(
  db: D1Database,
  tokenHash: string
): Promise<RefreshToken | null> {
  return db
    .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
    .bind(tokenHash)
    .first<RefreshToken>();
}

export async function createRefreshToken(
  db: D1Database,
  params: {
    id: string;
    userId: string;
    serviceId: string | null;
    tokenHash: string;
    familyId: string;
    expiresAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO refresh_tokens (id, user_id, service_id, token_hash, family_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      params.userId,
      params.serviceId,
      params.tokenHash,
      params.familyId,
      params.expiresAt
    )
    .run();
}

export async function revokeRefreshToken(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE id = ?`)
    .bind(id)
    .run();
}

/**
 * reuse detection: family全体を失効させる
 */
export async function revokeTokenFamily(db: D1Database, familyId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE family_id = ? AND revoked_at IS NULL`
    )
    .bind(familyId)
    .run();
}

export async function revokeUserTokens(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`
    )
    .bind(userId)
    .run();
}

export interface UserConnection {
  service_id: string;
  service_name: string;
  client_id: string;
  first_authorized_at: string;
  last_authorized_at: string;
}

/**
 * ユーザーがアクティブなリフレッシュトークンを持つサービス一覧を返す
 */
export async function listUserConnections(
  db: D1Database,
  userId: string
): Promise<UserConnection[]> {
  const result = await db
    .prepare(
      `SELECT s.id as service_id, s.name as service_name, s.client_id,
              MIN(rt.created_at) as first_authorized_at,
              MAX(rt.created_at) as last_authorized_at
       FROM refresh_tokens rt
       JOIN services s ON rt.service_id = s.id
       WHERE rt.user_id = ?
         AND rt.revoked_at IS NULL
         AND rt.expires_at > datetime('now')
       GROUP BY s.id, s.name, s.client_id
       ORDER BY last_authorized_at DESC`
    )
    .bind(userId)
    .all<UserConnection>();
  return result.results;
}

export async function countActiveRefreshTokens(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COUNT(*) as count FROM refresh_tokens
       WHERE revoked_at IS NULL AND expires_at > datetime('now')`
    )
    .first<{ count: number }>();
  return result?.count ?? 0;
}

/**
 * ユーザーが特定サービスにアクティブな認可を持つか確認する
 */
export async function hasUserAuthorizedService(
  db: D1Database,
  userId: string,
  serviceId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT 1 FROM refresh_tokens
       WHERE user_id = ? AND service_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
       LIMIT 1`
    )
    .bind(userId, serviceId)
    .first<{ 1: number }>();
  return result !== null;
}

/**
 * 特定サービスに認可済みのユーザー一覧を返す（アクティブなリフレッシュトークン保有者）
 * EXISTS を使うことで重複行の生成を避け、ページング安定性のため副キー(u.id)を追加。
 */
export async function listUsersAuthorizedForService(
  db: D1Database,
  serviceId: string,
  limit: number = 50,
  offset: number = 0
): Promise<User[]> {
  const result = await db
    .prepare(
      `SELECT u.*
       FROM users u
       WHERE EXISTS (
         SELECT 1 FROM refresh_tokens rt
         WHERE rt.user_id = u.id
           AND rt.service_id = ?
           AND rt.revoked_at IS NULL
           AND rt.expires_at > datetime('now')
       )
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ? OFFSET ?`
    )
    .bind(serviceId, limit, offset)
    .all<User>();
  return result.results;
}

/**
 * 特定サービスに認可済みのユーザー数を返す
 */
export async function countUsersAuthorizedForService(
  db: D1Database,
  serviceId: string
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COUNT(*) as count
       FROM users u
       WHERE EXISTS (
         SELECT 1 FROM refresh_tokens rt
         WHERE rt.user_id = u.id
           AND rt.service_id = ?
           AND rt.revoked_at IS NULL
           AND rt.expires_at > datetime('now')
       )`
    )
    .bind(serviceId)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

/**
 * 特定サービスのユーザートークンを全て失効させる
 */
export async function revokeUserServiceTokens(
  db: D1Database,
  userId: string,
  serviceId: string
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE refresh_tokens SET revoked_at = datetime('now')
       WHERE user_id = ? AND service_id = ? AND revoked_at IS NULL`
    )
    .bind(userId, serviceId)
    .run();
  return result.meta.changes ?? 0;
}
