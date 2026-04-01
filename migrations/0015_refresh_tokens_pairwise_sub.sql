-- refresh_tokensにペアワイズsubカラムを追加（外部API検索のO(N)スキャン解消）
ALTER TABLE refresh_tokens ADD COLUMN pairwise_sub TEXT;
CREATE INDEX idx_refresh_tokens_pairwise_sub ON refresh_tokens(service_id, pairwise_sub);
