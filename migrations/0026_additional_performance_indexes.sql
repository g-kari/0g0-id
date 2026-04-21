-- パフォーマンス改善: 追加インデックス (refs #160)
--
-- 既存クエリパターンの分析に基づき、頻繁に使用される WHERE 条件に対応するインデックスを追加する。

-- refresh_tokens: service_id 単独検索用
-- revokeAllServiceTokens / getServiceTokenStats / listUsersAuthorizedForService で使用
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_service_id
  ON refresh_tokens(service_id);

-- refresh_tokens: pairwise_sub + service_id の複合検索用
-- findUserIdByPairwiseSub で使用（外部APIからのユーザー逆引き）
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_pairwise_sub_service
  ON refresh_tokens(service_id, pairwise_sub)
  WHERE revoked_at IS NULL;

-- bff_sessions: ユーザー別アクティブセッション一覧の複合条件用
-- listActiveBffSessionsByUserId / countActiveBffSessionsByUserId / revokeAllBffSessionsByUserId で使用
-- user_id + revoked_at の部分インデックスで「アクティブのみ」を効率的に絞り込む
CREATE INDEX IF NOT EXISTS idx_bff_sessions_user_active
  ON bff_sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;

-- login_events: ユーザー別の日時順取得用（複合インデックス）
-- listLoginEventsByUserId で ORDER BY created_at DESC と組み合わせて使用
CREATE INDEX IF NOT EXISTS idx_login_events_user_created
  ON login_events(user_id, created_at DESC);
