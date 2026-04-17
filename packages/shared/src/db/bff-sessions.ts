/**
 * BFF セッション管理（bff_sessions テーブル）
 *
 * BFF（user.0g0.xyz / admin.0g0.xyz）の暗号化済みセッション Cookie を
 * サーバー側で任意失効可能にするための永続レイヤ。
 *
 * 呼び出しは ID Worker の内部ルート（/internal/bff-sessions/*）経由のみを想定。
 * BFF Worker は D1 バインディングを持たず、Service Binding で ID Worker に委譲する。
 */

export interface BffSessionRecord {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_reason: string | null;
  user_agent: string | null;
  ip: string | null;
  bff_origin: string;
}

export interface CreateBffSessionInput {
  id: string;
  userId: string;
  expiresAt: number;
  bffOrigin: string;
  userAgent?: string | null;
  ip?: string | null;
}

/**
 * BFF セッションを作成する。id（UUID 等）・user_id・expires_at（unix秒）が必須。
 */
export async function createBffSession(
  db: D1Database,
  input: CreateBffSessionInput,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO bff_sessions (id, user_id, created_at, expires_at, user_agent, ip, bff_origin)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.userId,
      now,
      input.expiresAt,
      input.userAgent ?? null,
      input.ip ?? null,
      input.bffOrigin,
    )
    .run();
}

/**
 * 有効な（未失効・未期限切れ）BFF セッションを返す。
 * 失効済み・期限切れ・存在しない場合は null。
 */
export async function findActiveBffSession(
  db: D1Database,
  sessionId: string,
): Promise<BffSessionRecord | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `SELECT id, user_id, created_at, expires_at, revoked_at, revoked_reason,
              user_agent, ip, bff_origin
         FROM bff_sessions
        WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(sessionId, now)
    .first<BffSessionRecord>();
  return row ?? null;
}

/**
 * 単一のBFFセッションを失効させる。既に失効済みの場合は no-op。
 */
export async function revokeBffSession(
  db: D1Database,
  sessionId: string,
  reason: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE bff_sessions
          SET revoked_at = ?, revoked_reason = ?
        WHERE id = ? AND revoked_at IS NULL`,
    )
    .bind(now, reason, sessionId)
    .run();
}

/**
 * ユーザーの全BFFセッションを失効させる（全デバイスサインアウト）。
 * 失効件数を返す。
 */
export async function revokeAllBffSessionsByUserId(
  db: D1Database,
  userId: string,
  reason: string,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(
      `UPDATE bff_sessions
          SET revoked_at = ?, revoked_reason = ?
        WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .bind(now, reason, userId)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * 期限切れ・失効済みで一定期間経過した BFF セッションを削除する（日次cron想定）。
 * 失効後7日保持で削除。
 */
export async function cleanupStaleBffSessions(db: D1Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const graceSeconds = 7 * 24 * 60 * 60;
  await db
    .prepare(
      `DELETE FROM bff_sessions
        WHERE expires_at < ?
           OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
    )
    .bind(now, now - graceSeconds)
    .run();
}

/**
 * ユーザーの有効な BFF セッション件数を取得する（セキュリティダッシュボード向け）。
 */
export async function countActiveBffSessionsByUserId(
  db: D1Database,
  userId: string,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt
         FROM bff_sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(userId, now)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}
