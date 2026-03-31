ALTER TABLE admin_audit_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'success';
CREATE INDEX idx_admin_audit_logs_status ON admin_audit_logs(status);
