-- DBSC (Device Bound Session Credentials) Phase 2 — challenge-response 用チャレンジテーブル
-- /auth/dbsc/refresh で発行する nonce を一時保存する。
--
-- - Chrome は最初の POST で nonce を貰い、秘密鍵で署名した JWT proof を再送する。
-- - nonce はワンタイム（consumed_at で使用済みマーキング）。リプレイ攻撃を排除。
-- - expires_at は短い TTL（60 秒想定）。
-- - session_id で FK を張り、セッション失効に連動させる（ON DELETE CASCADE）。
--
-- 複数の並行リフレッシュに備え、同一セッションで複数の未消費 nonce を持てるようにする
-- （PRIMARY KEY は nonce 単体）。列挙攻撃を避けるため nonce は十分長い乱数にする。

CREATE TABLE IF NOT EXISTS dbsc_challenges (
  nonce TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES bff_sessions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dbsc_challenges_session_id ON dbsc_challenges (session_id);
CREATE INDEX IF NOT EXISTS idx_dbsc_challenges_expires_at ON dbsc_challenges (expires_at);
