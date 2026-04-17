-- BFF セッション管理テーブル
-- BFF (user.0g0.xyz / admin.0g0.xyz) のセッション Cookie を D1 上で任意失効可能にする。
-- Cookie 自体は AES-GCM 暗号化されているが、クライアント側で30日保持されるため
-- 端末マルウェア等で Cookie が漏洩した場合の強制失効手段がなかった。
-- このテーブルに session_id を持たせて BFF リクエスト毎に有効性を検証することで、
-- リモート失効（管理画面・ログアウト・全デバイスサインアウト）を可能にする。

CREATE TABLE IF NOT EXISTS bff_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT,
  user_agent TEXT,
  ip TEXT,
  bff_origin TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bff_sessions_user_id ON bff_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_bff_sessions_expires_at ON bff_sessions (expires_at);
