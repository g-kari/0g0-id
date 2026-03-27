-- refresh_tokensテーブルにrevoked_reasonカラムを追加
-- 失効理由: user_logout, user_logout_all, user_logout_others, reuse_detected,
--           service_delete, service_revoke, rotation, security_event, admin_action
ALTER TABLE refresh_tokens ADD COLUMN revoked_reason TEXT;
