/**
 * RFC 7009: アクセストークン失効テーブル（jtiブロックリスト）の操作関数。
 * アクセストークンはステートレスなJWTのため、失効にはjtiをブロックリストで管理する。
 */

/**
 * アクセストークンのjtiをブロックリストに追加する。
 * INSERT OR IGNORE で冪等性を保証（二重登録は無視）。
 */
export async function addRevokedAccessToken(
  db: D1Database,
  jti: string,
  expiresAt: number,
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO revoked_access_tokens (jti, expires_at) VALUES (?, ?)")
    .bind(jti, expiresAt)
    .run();
}

/**
 * アクセストークンのjtiがブロックリストに存在するか確認する。
 * 期限切れレコードは除外（unixepoch() との比較）。
 */
export async function isAccessTokenRevoked(db: D1Database, jti: string): Promise<boolean> {
  const result = await db
    .prepare("SELECT 1 FROM revoked_access_tokens WHERE jti = ? AND expires_at > unixepoch()")
    .bind(jti)
    .first();
  return result !== null;
}

/**
 * 期限切れのjtiブロックリストエントリを削除する。
 * scheduled ハンドラーから定期実行してテーブルの肥大化を防ぐ。
 */
export async function cleanupExpiredRevokedAccessTokens(db: D1Database): Promise<number> {
  const result = await db
    .prepare("DELETE FROM revoked_access_tokens WHERE expires_at <= unixepoch()")
    .run();
  return result.meta.changes ?? 0;
}
