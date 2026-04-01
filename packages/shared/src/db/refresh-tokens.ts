import type { RefreshToken, User } from '../types';
import { escapeLikePattern } from '../lib/sql';

export type RevokeReason =
  | 'user_logout'
  | 'user_logout_all'
  | 'user_logout_others'
  | 'reuse_detected'
  | 'service_delete'
  | 'service_revoke'
  | 'rotation'
  | 'security_event'
  | 'admin_action'
  | 'expired';

export async function findRefreshTokenByHash(
  db: D1Database,
  tokenHash: string
): Promise<RefreshToken | null> {
  return db
    .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
    .bind(tokenHash)
    .first<RefreshToken>();
}

/**
 * アトミックにリフレッシュトークンを失効させる（TOCTOU競合状態防止）。
 * 失効前に有効だったトークンを返す。トークンが存在しないか既に失効済みの場合は null を返す。
 */
export async function findAndRevokeRefreshToken(
  db: D1Database,
  tokenHash: string,
  reason?: RevokeReason
): Promise<RefreshToken | null> {
  return db
    .prepare(
      `UPDATE refresh_tokens
       SET revoked_at = datetime('now'), revoked_reason = ?
       WHERE token_hash = ?
         AND revoked_at IS NULL
       RETURNING *`
    )
    .bind(reason ?? null, tokenHash)
    .first<RefreshToken>();
}

export async function unrevokeRefreshToken(
  db: D1Database,
  tokenId: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE refresh_tokens
       SET revoked_at = NULL, revoked_reason = NULL
       WHERE id = ?
         AND revoked_at IS NOT NULL
         AND revoked_reason = 'rotation'`
    )
    .bind(tokenId)
    .run();
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
    pairwiseSub?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO refresh_tokens (id, user_id, service_id, token_hash, family_id, expires_at, pairwise_sub)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      params.userId,
      params.serviceId,
      params.tokenHash,
      params.familyId,
      params.expiresAt,
      params.pairwiseSub ?? null
    )
    .run();
}

/** ペアワイズsubからユーザーIDを逆引きする（外部API用） */
export async function findUserIdByPairwiseSub(
  db: D1Database,
  serviceId: string,
  pairwiseSub: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT DISTINCT user_id FROM refresh_tokens
       WHERE service_id = ? AND pairwise_sub = ?
         AND revoked_at IS NULL AND datetime(expires_at) > datetime('now')
       LIMIT 1`
    )
    .bind(serviceId, pairwiseSub)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export async function revokeRefreshToken(db: D1Database, id: string, reason?: RevokeReason): Promise<void> {
  await db
    .prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now'), revoked_reason = ? WHERE id = ?`)
    .bind(reason ?? null, id)
    .run();
}

/**
 * reuse detection: family全体を失効させる
 */
export async function revokeTokenFamily(db: D1Database, familyId: string, reason?: RevokeReason): Promise<void> {
  await db
    .prepare(
      `UPDATE refresh_tokens SET revoked_at = datetime('now'), revoked_reason = ? WHERE family_id = ? AND revoked_at IS NULL`
    )
    .bind(reason ?? null, familyId)
    .run();
}

export async function revokeUserTokens(db: D1Database, userId: string, reason?: RevokeReason): Promise<void> {
  await db
    .prepare(
      `UPDATE refresh_tokens SET revoked_at = datetime('now'), revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL`
    )
    .bind(reason ?? null, userId)
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
         AND datetime(rt.expires_at) > datetime('now')
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
       WHERE revoked_at IS NULL AND datetime(expires_at) > datetime('now')`
    )
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export interface ActiveSession {
  id: string;
  service_id: string | null;
  service_name: string | null;
  created_at: string;
  expires_at: string;
}

/**
 * ユーザーのアクティブセッション一覧を返す。
 * IdPセッション（service_id IS NULL）とサービストークン両方を含む。
 * token_hash / family_id などの機密フィールドは含まない。
 */
export async function listActiveSessionsByUserId(
  db: D1Database,
  userId: string
): Promise<ActiveSession[]> {
  const result = await db
    .prepare(
      `SELECT rt.id, rt.service_id, s.name as service_name, rt.created_at, rt.expires_at
       FROM refresh_tokens rt
       LEFT JOIN services s ON rt.service_id = s.id
       WHERE rt.user_id = ?
         AND rt.revoked_at IS NULL
         AND datetime(rt.expires_at) > datetime('now')
       ORDER BY rt.created_at DESC`
    )
    .bind(userId)
    .all<ActiveSession>();
  return result.results;
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
       WHERE user_id = ? AND service_id = ? AND revoked_at IS NULL AND datetime(expires_at) > datetime('now')
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
export interface AuthorizedUserFilter {
  name?: string;
  email?: string;
}

export async function listUsersAuthorizedForService(
  db: D1Database,
  serviceId: string,
  limit: number = 50,
  offset: number = 0,
  filter?: AuthorizedUserFilter
): Promise<User[]> {
  const conditions: string[] = [];
  const bindings: unknown[] = [serviceId];

  if (filter?.name) {
    conditions.push("AND u.name LIKE ? ESCAPE '\\'");
    bindings.push(`%${escapeLikePattern(filter.name)}%`);
  }
  if (filter?.email) {
    conditions.push("AND u.email LIKE ? ESCAPE '\\'");
    bindings.push(`%${escapeLikePattern(filter.email)}%`);
  }

  const extraConditions = conditions.length > 0 ? '\n       ' + conditions.join('\n       ') : '';
  const result = await db
    .prepare(
      `SELECT u.*
       FROM users u
       WHERE EXISTS (
         SELECT 1 FROM refresh_tokens rt
         WHERE rt.user_id = u.id
           AND rt.service_id = ?
           AND rt.revoked_at IS NULL
           AND datetime(rt.expires_at) > datetime('now')
       )${extraConditions}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...bindings, limit, offset)
    .all<User>();
  return result.results;
}

/**
 * 特定サービスに認可済みのユーザー数を返す
 */
export async function countUsersAuthorizedForService(
  db: D1Database,
  serviceId: string,
  filter?: AuthorizedUserFilter
): Promise<number> {
  const conditions: string[] = [];
  const bindings: unknown[] = [serviceId];

  if (filter?.name) {
    conditions.push("AND u.name LIKE ? ESCAPE '\\'");
    bindings.push(`%${escapeLikePattern(filter.name)}%`);
  }
  if (filter?.email) {
    conditions.push("AND u.email LIKE ? ESCAPE '\\'");
    bindings.push(`%${escapeLikePattern(filter.email)}%`);
  }

  const extraConditions = conditions.length > 0 ? '\n       ' + conditions.join('\n       ') : '';
  const result = await db
    .prepare(
      `SELECT COUNT(*) as count
       FROM users u
       WHERE EXISTS (
         SELECT 1 FROM refresh_tokens rt
         WHERE rt.user_id = u.id
           AND rt.service_id = ?
           AND rt.revoked_at IS NULL
           AND datetime(rt.expires_at) > datetime('now')
       )${extraConditions}`
    )
    .bind(...bindings)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

/**
 * 特定サービスのユーザートークンを全て失効させる
 */
export async function revokeUserServiceTokens(
  db: D1Database,
  userId: string,
  serviceId: string,
  reason?: RevokeReason
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE refresh_tokens SET revoked_at = datetime('now'), revoked_reason = ?
       WHERE user_id = ? AND service_id = ? AND revoked_at IS NULL`
    )
    .bind(reason ?? null, userId, serviceId)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * サービスに属する全ユーザーのアクティブトークンを一括失効させる。
 * サービス削除時に呼び出し、削除されたサービスのトークンが残存しないようにする。
 * 失効したトークン数を返す。
 */
export async function revokeAllServiceTokens(db: D1Database, serviceId: string, reason?: RevokeReason): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE refresh_tokens SET revoked_at = datetime('now'), revoked_reason = ?
       WHERE service_id = ? AND revoked_at IS NULL`
    )
    .bind(reason ?? null, serviceId)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * 指定した token_hash 以外のユーザートークンを全て失効させる（他デバイスからのログアウト）。
 * 失効したトークン数を返す。
 */
export async function revokeOtherUserTokens(
  db: D1Database,
  userId: string,
  excludeTokenHash: string,
  reason?: RevokeReason
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE refresh_tokens SET revoked_at = datetime('now'), revoked_reason = ?
       WHERE user_id = ? AND token_hash != ? AND revoked_at IS NULL`
    )
    .bind(reason ?? null, userId, excludeTokenHash)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * 特定のリフレッシュトークン（セッション）をユーザー所有権チェック付きで失効させる。
 * 対象トークンが存在しない・既に失効済み・別ユーザー所有の場合は 0 を返す。
 */
export async function revokeTokenByIdForUser(
  db: D1Database,
  tokenId: string,
  userId: string,
  reason?: RevokeReason
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE refresh_tokens SET revoked_at = datetime('now'), revoked_reason = ?
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
    )
    .bind(reason ?? null, tokenId, userId)
    .run();
  return result.meta.changes ?? 0;
}

export interface ServiceTokenStat {
  service_id: string;
  service_name: string;
  authorized_user_count: number;
  active_token_count: number;
}

/**
 * 全サービスのアクティブトークン統計を返す。
 * 各サービスについて、アクティブなリフレッシュトークンを持つユニークユーザー数と
 * アクティブトークン総数を集計する。
 */
export async function getServiceTokenStats(db: D1Database): Promise<ServiceTokenStat[]> {
  const result = await db
    .prepare(
      `SELECT s.id as service_id, s.name as service_name,
              COUNT(DISTINCT rt.user_id) as authorized_user_count,
              COUNT(rt.id) as active_token_count
       FROM services s
       LEFT JOIN refresh_tokens rt ON rt.service_id = s.id
         AND rt.revoked_at IS NULL
         AND datetime(rt.expires_at) > datetime('now')
       GROUP BY s.id, s.name
       ORDER BY authorized_user_count DESC`
    )
    .all<ServiceTokenStat>();
  return result.results;
}
