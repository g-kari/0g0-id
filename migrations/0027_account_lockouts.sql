-- アカウントロックアウト管理テーブル（issue #172）
-- ログイン試行失敗の追跡と一時的なアカウントロック

-- login_events に成功/失敗フラグを追加（既存データは成功扱い）
ALTER TABLE login_events ADD COLUMN success INTEGER NOT NULL DEFAULT 1;

-- アカウントロックアウトテーブル
CREATE TABLE IF NOT EXISTS account_lockouts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_failed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_account_lockouts_locked_until ON account_lockouts(locked_until);
