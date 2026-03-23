-- OIDC改善: auth_codesテーブルにnonce・PKCE・スコープカラムを追加
ALTER TABLE auth_codes ADD COLUMN nonce TEXT;
ALTER TABLE auth_codes ADD COLUMN code_challenge TEXT;
ALTER TABLE auth_codes ADD COLUMN code_challenge_method TEXT;
ALTER TABLE auth_codes ADD COLUMN scope TEXT;
