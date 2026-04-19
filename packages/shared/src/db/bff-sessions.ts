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
  /** DBSC 端末バインド公開鍵（ES256 JWK の JSON 文字列）。未バインドなら null。 */
  device_public_key_jwk: string | null;
  /** DBSC 端末バインド日時（unix 秒）。未バインドなら null。 */
  device_bound_at: number | null;
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
              user_agent, ip, bff_origin, device_public_key_jwk, device_bound_at
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
 * 単一の BFF セッションを user_id 一致条件付きで失効させる（管理者操作向け）。
 * 失効件数を返す（指定 session が指定 user に紐づいていない場合は 0）。
 */
export async function revokeBffSessionByIdForUser(
  db: D1Database,
  sessionId: string,
  userId: string,
  reason: string,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(
      `UPDATE bff_sessions
          SET revoked_at = ?, revoked_reason = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .bind(now, reason, sessionId, userId)
    .run();
  return result.meta?.changes ?? 0;
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

/**
 * BFF セッションに DBSC 端末公開鍵をバインドする。
 *
 * - 既にバインド済み・失効済み・期限切れ・存在しないセッションには no-op で false を返す。
 * - 二重バインドを禁止する（端末追加は新規ログイン経由のみ）。
 * - 公開鍵 JWK は呼び出し側が事前に jose 等で検証してから渡す前提。
 */
export async function bindDeviceKeyToBffSession(
  db: D1Database,
  sessionId: string,
  publicKeyJwk: string,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(
      `UPDATE bff_sessions
          SET device_public_key_jwk = ?, device_bound_at = ?
        WHERE id = ?
          AND revoked_at IS NULL
          AND expires_at > ?
          AND device_public_key_jwk IS NULL`,
    )
    .bind(publicKeyJwk, now, sessionId, now)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * 管理画面向け BFF セッション一覧表示用サマリ。
 *
 * - `has_device_key`: DBSC 端末公開鍵がバインドされているか（内容自体は返さない）
 * - `device_bound_at`: バインド日時（unix 秒）。未バインドなら null。
 *
 * 公開鍵 JWK 生データは管理画面には返さない（UI では不要・漏洩面を増やさないため）。
 */
export interface ActiveBffSessionSummary {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  user_agent: string | null;
  ip: string | null;
  bff_origin: string;
  has_device_key: boolean;
  device_bound_at: number | null;
}

/**
 * ユーザーのアクティブ（未失効・未期限切れ）BFF セッション一覧を返す。
 * 作成日時の降順でソートする。管理者向けの閲覧専用サマリで、公開鍵そのものは返さない。
 */
export async function listActiveBffSessionsByUserId(
  db: D1Database,
  userId: string,
): Promise<ActiveBffSessionSummary[]> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(
      `SELECT id, user_id, created_at, expires_at, user_agent, ip, bff_origin,
              device_public_key_jwk, device_bound_at
         FROM bff_sessions
        WHERE user_id = ?
          AND revoked_at IS NULL
          AND expires_at > ?
        ORDER BY created_at DESC`,
    )
    .bind(userId, now)
    .all<
      Pick<
        BffSessionRecord,
        | "id"
        | "user_id"
        | "created_at"
        | "expires_at"
        | "user_agent"
        | "ip"
        | "bff_origin"
        | "device_public_key_jwk"
        | "device_bound_at"
      >
    >();
  return result.results.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    user_agent: row.user_agent,
    ip: row.ip,
    bff_origin: row.bff_origin,
    has_device_key: row.device_public_key_jwk !== null,
    device_bound_at: row.device_bound_at,
  }));
}
