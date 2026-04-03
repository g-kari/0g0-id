import type { AuthCode } from '../types';

export async function createAuthCode(
  db: D1Database,
  params: {
    id: string;
    userId: string;
    serviceId?: string | null;
    codeHash: string;
    redirectTo: string;
    expiresAt: string;
    nonce?: string | null;
    codeChallenge?: string | null;
    codeChallengeMethod?: string | null;
    scope?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth_codes (id, user_id, service_id, code_hash, redirect_to, expires_at, nonce, code_challenge, code_challenge_method, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      params.userId,
      params.serviceId ?? null,
      params.codeHash,
      params.redirectTo,
      params.expiresAt,
      params.nonce ?? null,
      params.codeChallenge ?? null,
      params.codeChallengeMethod ?? null,
      params.scope ?? null
    )
    .run();
}

export async function findAndConsumeAuthCode(
  db: D1Database,
  codeHash: string
): Promise<AuthCode | null> {
  return db
    .prepare(
      `UPDATE auth_codes
       SET used_at = datetime('now')
       WHERE code_hash = ?
         AND used_at IS NULL
         AND datetime(expires_at) >= datetime('now')
       RETURNING *`
    )
    .bind(codeHash)
    .first<AuthCode>();
}

export async function cleanupExpiredAuthCodes(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM auth_codes
       WHERE datetime(expires_at) < datetime('now')
          OR used_at IS NOT NULL`
    )
    .run();
  return result.meta.changes ?? 0;
}
