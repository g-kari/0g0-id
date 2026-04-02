-- リフレッシュトークンに発行時のスコープを記録
-- リフレッシュ時にスコープ昇格を防止するために必要
ALTER TABLE refresh_tokens ADD COLUMN scope TEXT;
