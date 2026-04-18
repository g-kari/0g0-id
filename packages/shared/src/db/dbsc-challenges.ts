/**
 * DBSC (Device Bound Session Credentials) チャレンジ管理（dbsc_challenges テーブル）
 *
 * Phase 2 の challenge-response 方式で使用する短寿命 nonce を管理する。
 *
 * フロー:
 * 1. BFF が POST /auth/dbsc/refresh を受け取ると、IdP で nonce を発行し 403 で応答。
 *    `Secure-Session-Challenge: "<nonce>"` ヘッダを付与。
 * 2. Chrome が端末秘密鍵で nonce を含む JWT proof を署名して再送。
 * 3. BFF が IdP の verify API を通じて nonce の一回限りの消費と署名検証を行う。
 *
 * - nonce はワンタイム（consumed_at で使用済みにする）。リプレイ攻撃対策。
 * - TTL は 60 秒想定。
 * - 失効 UPDATE は WHERE で未消費・未期限切れをアトミックに絞り込む。
 */

/** 発行時に返すチャレンジ情報。 */
export interface DbscChallenge {
  nonce: string;
  session_id: string;
  expires_at: number;
}

/** 消費試行結果。 */
export interface DbscChallengeConsumeResult {
  ok: boolean;
  /** 消費できた場合の対応セッション ID（WHERE 句で一致確認するため呼び出し側で使う）。 */
  session_id?: string;
}

/**
 * チャレンジを発行する。nonce は十分長い乱数であることを呼び出し側で担保する。
 * TTL は `ttlSeconds`（省略時 60 秒）。
 */
export async function issueDbscChallenge(
  db: D1Database,
  input: { nonce: string; sessionId: string; ttlSeconds?: number },
): Promise<DbscChallenge> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? 60;
  const expiresAt = now + ttl;
  await db
    .prepare(
      `INSERT INTO dbsc_challenges (nonce, session_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(input.nonce, input.sessionId, now, expiresAt)
    .run();
  return { nonce: input.nonce, session_id: input.sessionId, expires_at: expiresAt };
}

/**
 * nonce を一回限り消費する（リプレイ対策）。
 *
 * - 未消費・未期限切れ・指定セッションに紐付く nonce のみを consumed_at でマーク。
 * - changes=0 の場合はリプレイ／不一致／期限切れ。呼び出し側は一律 INVALID_CHALLENGE として扱う。
 * - 列挙攻撃ヒントを避けるため理由は外向きに区別しない。
 */
export async function consumeDbscChallenge(
  db: D1Database,
  input: { nonce: string; sessionId: string },
): Promise<DbscChallengeConsumeResult> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(
      `UPDATE dbsc_challenges
          SET consumed_at = ?
        WHERE nonce = ?
          AND session_id = ?
          AND consumed_at IS NULL
          AND expires_at > ?`,
    )
    .bind(now, input.nonce, input.sessionId, now)
    .run();
  if ((result.meta?.changes ?? 0) > 0) {
    return { ok: true, session_id: input.sessionId };
  }
  return { ok: false };
}

/**
 * 期限切れ・消費済みで一定期間経過したチャレンジを削除する（日次cron想定）。
 * 消費後1時間・期限切れ後1時間で削除（監査用に短期保持）。
 */
export async function cleanupStaleDbscChallenges(db: D1Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const graceSeconds = 60 * 60;
  await db
    .prepare(
      `DELETE FROM dbsc_challenges
        WHERE expires_at < ?
           OR (consumed_at IS NOT NULL AND consumed_at < ?)`,
    )
    .bind(now - graceSeconds, now - graceSeconds)
    .run();
}
