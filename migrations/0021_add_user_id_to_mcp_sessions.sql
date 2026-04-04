-- mcp_sessionsテーブルにuser_idカラムを追加（セッションハイジャック時のユーザー単位無効化のため）
ALTER TABLE mcp_sessions ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_mcp_sessions_user_id ON mcp_sessions (user_id);
