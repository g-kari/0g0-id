-- リフレッシュトークンを resource の「登録世代」に束縛する。
--
-- refresh_tokens.resource は URI 文字列のため、resource を削除して同じ URI を
-- 再登録すると、旧登録で発行されたトークンと区別できず、再登録時に旧 grant が
-- 復活してしまう。また削除処理と refresh が並行すると、検証通過後に削除が
-- 完了し、その後で後継トークンが発行される競合もあった。
--
-- resource_server_id には発行時点で検証した resource_servers 行の id（登録ごとに
-- 発行される UUID = 登録世代）を記録する。refresh 時は現在の行 id と一致する
-- 場合のみ継続を許可し、後継トークンの INSERT は対象行が存在する間だけ成功する
-- 条件付き INSERT で原子的に行う（発行側のコードを参照）。
ALTER TABLE refresh_tokens ADD COLUMN resource_server_id TEXT;
CREATE INDEX idx_refresh_tokens_resource_server_id ON refresh_tokens(resource_server_id);
