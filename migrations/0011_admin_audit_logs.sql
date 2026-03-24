-- 管理者操作の監査ログテーブル
-- 管理者によるロール変更・BAN・サービス削除などの操作履歴を記録する
CREATE TABLE admin_audit_logs (
  id          TEXT     PRIMARY KEY NOT NULL,
  admin_user_id TEXT   NOT NULL,
  action      TEXT     NOT NULL,
  target_type TEXT     NOT NULL,
  target_id   TEXT     NOT NULL,
  details     TEXT,
  ip_address  TEXT,
  created_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_admin_audit_logs_admin_user_id ON admin_audit_logs(admin_user_id);
CREATE INDEX idx_admin_audit_logs_created_at    ON admin_audit_logs(created_at DESC);
CREATE INDEX idx_admin_audit_logs_target        ON admin_audit_logs(target_type, target_id);
