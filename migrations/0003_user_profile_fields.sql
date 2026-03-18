-- ユーザープロフィール拡張: 電話番号・住所フィールド追加
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN address TEXT;
