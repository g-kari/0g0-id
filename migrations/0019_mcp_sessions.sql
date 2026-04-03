-- MCPセッション管理テーブル（Workerスケールアウト対応のためD1永続化）
CREATE TABLE IF NOT EXISTS mcp_sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_sessions_last_active_at ON mcp_sessions (last_active_at);
