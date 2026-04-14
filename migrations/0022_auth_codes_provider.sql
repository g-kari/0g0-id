-- auth_codesテーブルにproviderカラムを追加（amrクレーム生成用）
-- OIDC Core 1.0: IDトークンのamr（Authentication Methods References）に使用する
ALTER TABLE auth_codes ADD COLUMN provider TEXT;
