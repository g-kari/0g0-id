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
  expiresAt: number
): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO revoked_access_tokens (jti, expires_at) VALUES (?, ?)')
    .bind(jti, expiresAt)
    .run();
}

/**
 * アクセストークンのjtiがブロックリストに存在するか確認する。
 * 期限切れレコードも含めて確認（期限切れトークンはintrospectでexpチェックにより弾かれる）。
 */
export async function isAccessTokenRevoked(db: D1Database, jti: string): Promise<boolean> {
  const result = await db
    .prepare('SELECT 1 FROM revoked_access_tokens WHERE jti = ?')
    .bind(jti)
    .first();
  return result !== null;
}
