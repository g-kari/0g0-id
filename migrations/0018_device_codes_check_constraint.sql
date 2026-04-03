-- device_codes: approved_at が設定されている場合、user_id も必ず設定されていることを保証する
-- approved_at と user_id の不整合を防止（DB直接操作時のリスク対策）

-- SQLiteはALTER TABLE ADD CONSTRAINTをサポートしないため、テーブル再作成で対応
CREATE TABLE device_codes_new (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  scope TEXT,
  expires_at TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  approved_at TEXT,
  denied_at TEXT,
  last_polled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (approved_at IS NULL OR user_id IS NOT NULL)
);

INSERT INTO device_codes_new SELECT * FROM device_codes;

DROP TABLE device_codes;

ALTER TABLE device_codes_new RENAME TO device_codes;

-- インデックス再作成
CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes(user_code);
CREATE INDEX IF NOT EXISTS idx_device_codes_expires ON device_codes(expires_at);
