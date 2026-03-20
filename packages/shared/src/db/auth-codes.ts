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
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth_codes (id, user_id, service_id, code_hash, redirect_to, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(params.id, params.userId, params.serviceId ?? null, params.codeHash, params.redirectTo, params.expiresAt)
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
         AND expires_at >= datetime('now')
       RETURNING *`
    )
    .bind(codeHash)
    .first<AuthCode>();
}
