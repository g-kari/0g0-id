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
  registration_id TEXT NOT NULL UNIQUE,
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

-- Signup-only email proof, never an OAuth-account linking proof.
CREATE TABLE email_signup_intents (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose = 'signup'),
  token_hash TEXT UNIQUE CHECK (token_hash IS NULL OR length(token_hash) = 64),
  authority_hash TEXT UNIQUE CHECK (authority_hash IS NULL OR length(authority_hash) = 64),
  browser_binding_hash TEXT NOT NULL CHECK (length(browser_binding_hash) = 64),
  expected_origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 900),
  verified_at INTEGER,
  consumed_at INTEGER,
  CHECK ((verified_at IS NULL AND token_hash IS NOT NULL AND authority_hash IS NULL)
    OR (verified_at IS NOT NULL AND token_hash IS NULL AND authority_hash IS NOT NULL)),
  CHECK (consumed_at IS NULL OR verified_at IS NOT NULL)
);
CREATE INDEX idx_email_signup_email_time ON email_signup_intents(email COLLATE NOCASE, created_at);
CREATE INDEX idx_email_signup_browser_time ON email_signup_intents(browser_binding_hash, created_at);
CREATE INDEX idx_email_signup_expiry ON email_signup_intents(expires_at);

-- Delivery ledger only: plaintext tokens are deliberately NOT persisted.
CREATE TABLE email_signup_outbox (
  intent_id TEXT PRIMARY KEY REFERENCES email_signup_intents(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'accepted', 'rejected', 'uncertain', 'discarded')),
  claim_id TEXT UNIQUE,
  message_id TEXT,
  rejection_code TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  finalized_at INTEGER,
  CHECK ((state IN ('queued', 'discarded') AND claim_id IS NULL AND claimed_at IS NULL)
    OR (state IN ('claimed', 'accepted', 'rejected', 'uncertain') AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK ((state IN ('queued', 'claimed') AND finalized_at IS NULL)
    OR (state IN ('accepted', 'rejected', 'uncertain', 'discarded') AND finalized_at IS NOT NULL)),
  CHECK ((state = 'accepted' AND message_id IS NOT NULL) OR (state <> 'accepted' AND message_id IS NULL)),
  CHECK ((state = 'rejected' AND rejection_code IS NOT NULL) OR (state <> 'rejected' AND rejection_code IS NULL))
);

-- A reserved subject exists only here until the final atomic signup batch.
CREATE TABLE passkey_signup_pending (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES email_signup_intents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE,
  webauthn_user_id TEXT NOT NULL UNIQUE,
  challenge TEXT NOT NULL UNIQUE,
  browser_binding_hash TEXT NOT NULL,
  expected_origin TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Transaction-only assertions. A failed scalar predicate becomes NULL and
-- aborts the entire D1 batch via NOT NULL. No assertion authorizes a login.
CREATE TABLE passkey_signup_commit_guards (
  id TEXT NOT NULL PRIMARY KEY,
  proof TEXT NOT NULL UNIQUE
);


-- Stable opaque WebAuthn user handle, shared by all credentials of one user.
CREATE TABLE passkey_user_handles (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  webauthn_user_id TEXT NOT NULL UNIQUE
);
