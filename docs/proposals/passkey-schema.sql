-- Design proposal, not installed by the migration runner.
-- Promote only after email delivery, WebAuthn verification and rollout review are complete.
CREATE TABLE passkey_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL UNIQUE,
  ceremony TEXT NOT NULL CHECK (ceremony IN ('registration', 'authentication')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  browser_binding_hash TEXT NOT NULL CHECK (length(browser_binding_hash) = 64),
  expected_origin TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (ceremony <> 'registration' OR user_id IS NOT NULL)
);
CREATE INDEX idx_passkey_challenges_expiry ON passkey_challenges(expires_at);

-- Public-key metadata only. The authenticator retains the private key.
CREATE TABLE passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  sign_count INTEGER NOT NULL CHECK (sign_count BETWEEN 0 AND 4294967295),
  transports_json TEXT NOT NULL DEFAULT '[]',
  device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_passkey_credentials_user ON passkey_credentials(user_id);
