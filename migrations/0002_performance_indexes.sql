-- パフォーマンス改善: 部分インデックス追加
-- auth_codes: 未使用かつ有効期限内の検索用
CREATE INDEX IF NOT EXISTS idx_auth_codes_active
  ON auth_codes(code_hash, expires_at)
  WHERE used_at IS NULL;

-- refresh_tokens: 失効していないトークンの検索用
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_active
  ON refresh_tokens(token_hash, revoked_at)
  WHERE revoked_at IS NULL;

-- refresh_tokens: family_id + 失効チェックの組み合わせ（トークンリプレイ検出）
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family_active
  ON refresh_tokens(family_id, revoked_at)
  WHERE revoked_at IS NULL;
