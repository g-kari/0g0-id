-- LINE・Twitchプロバイダー対応: google_subをNULL許容に変更、line_sub/twitch_subカラム追加
-- SQLiteはNOT NULL制約の変更にテーブル再作成が必要
PRAGMA foreign_keys = OFF;

CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE,
  line_sub TEXT UNIQUE,
  twitch_sub TEXT UNIQUE,
  email TEXT UNIQUE NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  picture TEXT,
  phone TEXT,
  address TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO users_new (id, google_sub, line_sub, twitch_sub, email, email_verified, name, picture, phone, address, role, created_at, updated_at)
SELECT id, google_sub, NULL, NULL, email, email_verified, name, picture, phone, address, role, created_at, updated_at
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE INDEX idx_users_google_sub ON users(google_sub);
CREATE INDEX idx_users_line_sub ON users(line_sub);
CREATE INDEX idx_users_twitch_sub ON users(twitch_sub);
CREATE INDEX idx_users_email ON users(email);

PRAGMA foreign_keys = ON;
