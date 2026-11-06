-- OAuth リソースインジケーター (RFC 8707) と動的クライアント登録 (RFC 7591) の基盤
--
-- 1) auth_codes / refresh_tokens に resource を追加する。
--    認可リクエストで指定された resource（リソースサーバーの正規 URI）を
--    アクセストークンの aud に束縛するために、コード発行からリフレッシュまで引き継ぐ。
ALTER TABLE auth_codes ADD COLUMN resource TEXT;
ALTER TABLE refresh_tokens ADD COLUMN resource TEXT;

-- 2) リソースサーバーレジストリ。
--    resource として指定できるのは管理者がここに登録した URI のみ
--    （任意の URI を aud にするトークンは発行しない）。
CREATE TABLE resource_servers (
  id TEXT PRIMARY KEY,
  uri TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  allowed_scopes TEXT NOT NULL DEFAULT '[]',
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_resource_servers_uri ON resource_servers(uri);

-- 3) services に登録経路と RFC 7592 管理用トークンのハッシュを追加する。
--    - source: 登録経路（'admin' = 管理 API / 'dcr' = RFC 7591 自己登録）。
--    - registration_access_token_hash: RFC 7592 のクライアント構成
--      エンドポイント用アクセストークン（ハッシュのみ保存）。
--
--    owner_user_id は NOT NULL のまま維持する。services は複数の子テーブル
--    から参照される親テーブルのため、D1 のマイグレーション実行環境では
--    テーブル再作成（DROP TABLE）が暗黙 DELETE で子行を連鎖削除してしまい、
--    PRAGMA foreign_keys = OFF もトランザクション内では無効だった
--    （ローカル D1 で実証）。そのため DCR クライアントの所有者は
--    下記の専用システムユーザーが担う。
ALTER TABLE services ADD COLUMN source TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE services ADD COLUMN registration_access_token_hash TEXT;

-- 4) DCR クライアント専用のシステムユーザー。
--    google_sub は実在のプロバイダーから発行され得ない値で、このアカウント
--    ではログインできない。管理画面のユーザー一覧では名前で識別できる。
INSERT INTO users (id, google_sub, email, email_verified, name, role)
VALUES ('system-dcr-owner', 'system:dcr', 'dcr-system@system.0g0.xyz', 0, 'DCR自己登録クライアント（システム）', 'system');
