-- ユーザー停止機能: users テーブルに banned_at カラムを追加
-- NULL = 停止なし、値あり = 停止中（値は停止した日時）
ALTER TABLE users ADD COLUMN banned_at DATETIME NULL;
