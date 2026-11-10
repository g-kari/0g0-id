-- PROPOSAL ONLY. Not an automatic migration; do not apply to production.
-- Additive: preserves existing users, identities, and foreign-key references.
ALTER TABLE users ADD COLUMN discord_sub TEXT;
ALTER TABLE users ADD COLUMN steam_sub TEXT;
CREATE UNIQUE INDEX idx_users_discord_sub ON users(discord_sub) WHERE discord_sub IS NOT NULL;
CREATE UNIQUE INDEX idx_users_steam_sub ON users(steam_sub) WHERE steam_sub IS NOT NULL;

-- Only SHA-256 digests of state, cookie binding and signed payload are stored.
CREATE TABLE social_login_transactions (
  state_hash TEXT PRIMARY KEY NOT NULL CHECK(length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
  browser_binding_hash TEXT NOT NULL CHECK(length(browser_binding_hash) = 64 AND browser_binding_hash NOT GLOB '*[^0-9a-f]*'),
  state_payload_hash TEXT NOT NULL CHECK(length(state_payload_hash) = 64 AND state_payload_hash NOT GLOB '*[^0-9a-f]*'),
  provider TEXT NOT NULL CHECK(provider IN ('discord', 'steam')),
  idp_origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_social_login_transactions_expires_at ON social_login_transactions(expires_at);

-- Retain successful replay claims until expiration. Never upsert/replace a nonce.
CREATE TABLE steam_login_nonces (
  nonce_hash TEXT PRIMARY KEY NOT NULL CHECK(length(nonce_hash) = 64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_steam_login_nonces_expires_at ON steam_login_nonces(expires_at);

-- Mandatory single-use claim for the new providers' signed account-link tokens.
CREATE TABLE social_login_link_nonces (
  jti_hash TEXT PRIMARY KEY NOT NULL CHECK(length(jti_hash) = 64 AND jti_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_social_login_link_nonces_expires_at ON social_login_link_nonces(expires_at);
