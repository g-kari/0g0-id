-- login_events テーブルに country カラムを追加（CF-IPCountry ヘッダーから取得）
ALTER TABLE login_events ADD COLUMN country TEXT;
