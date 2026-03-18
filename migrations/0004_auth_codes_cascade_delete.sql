-- auth_codes.user_id に ON DELETE CASCADE を追加
-- SQLiteは外部キー制約の変更に再テーブル作成が必要
PRAGMA foreign_keys = OFF;

CREATE TABLE auth_codes_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT UNIQUE NOT NULL,
  redirect_to TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO auth_codes_new SELECT * FROM auth_codes;
DROP TABLE auth_codes;
ALTER TABLE auth_codes_new RENAME TO auth_codes;

CREATE INDEX idx_auth_codes_code_hash ON auth_codes(code_hash);

PRAGMA foreign_keys = ON;
