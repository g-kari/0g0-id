import type { AuthCode } from '../types';

export async function createAuthCode(
  db: D1Database,
  params: {
    id: string;
    userId: string;
    codeHash: string;
    redirectTo: string;
    expiresAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth_codes (id, user_id, code_hash, redirect_to, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(params.id, params.userId, params.codeHash, params.redirectTo, params.expiresAt)
    .run();
}

export async function findAndConsumeAuthCode(
  db: D1Database,
  codeHash: string
): Promise<AuthCode | null> {
  const code = await db
    .prepare('SELECT * FROM auth_codes WHERE code_hash = ? AND used_at IS NULL')
    .bind(codeHash)
    .first<AuthCode>();

  if (!code) return null;

  // 有効期限チェック
  if (new Date(code.expires_at) < new Date()) return null;

  // 使用済みにマーク
  await db
    .prepare(`UPDATE auth_codes SET used_at = datetime('now') WHERE id = ?`)
    .bind(code.id)
    .run();

  return code;
}
