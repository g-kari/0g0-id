import type { RefreshToken } from '../types';

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
