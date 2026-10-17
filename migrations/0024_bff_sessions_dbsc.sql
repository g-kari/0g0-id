-- DBSC (Device Bound Session Credentials) Phase 1 対応
-- bff_sessions に端末バインド情報を追加し、Cookie 漏洩時の他端末再利用を防ぐ。
-- Chrome が生成した端末公開鍵 (ES256 JWK) と紐付け日時を保持する。
-- Phase 1 ではバインド記録のみ（チャレンジ・リフレッシュは Phase 2 で対応）。

ALTER TABLE bff_sessions ADD COLUMN device_public_key_jwk TEXT;
ALTER TABLE bff_sessions ADD COLUMN device_bound_at INTEGER;
