-- auth_codes に service_id カラムを追加（外部サービス向け OAuth 2.0 Authorization Code フロー）
-- NULL = BFF フロー（既存の user/admin BFF）、非NULL = 登録済みサービスのフロー
ALTER TABLE auth_codes ADD COLUMN service_id TEXT REFERENCES services(id) ON DELETE CASCADE;
