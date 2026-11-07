import { generateToken, sha256 } from "../lib/crypto";
import { passkeyRelyingParty } from "./passkey-challenges";
import type { EmailSignupBinding } from "./email-signup-intents";

const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
export interface EmailSignupAuthority extends EmailSignupBinding {
  intentId: string;
  authority: string;
}
export interface PendingEmailPasskeySignup {
  id: string;
  intent_id: string;
  user_id: string;
  webauthn_user_id: string;
  challenge: string;
  browser_binding_hash: string;
  expected_origin: string;
  rp_id: string;
  expires_at: number;
}

async function context(input: EmailSignupAuthority) {
  if (!SECRET_RE.test(input.authority) || !SECRET_RE.test(input.browserBinding))
    throw new Error("Invalid enrollment context");
  return {
    authorityHash: await sha256(input.authority),
    browserHash: await sha256(input.browserBinding),
    ...passkeyRelyingParty(input.idpOrigin),
    now: Math.floor(Date.now() / 1000),
  };
}

/** Only after email proof; reserves an opaque user ID, never creates a user. */
export async function issuePendingEmailPasskeySignup(
  db: D1Database,
  input: EmailSignupAuthority,
): Promise<PendingEmailPasskeySignup | null> {
  const c = await context(input);
  return db
    .prepare(`INSERT INTO passkey_signup_pending
    (id, intent_id, user_id, webauthn_user_id, challenge, browser_binding_hash, expected_origin, rp_id, expires_at)
    SELECT ?, i.id, ?, ?, ?, i.browser_binding_hash, i.expected_origin, ?, min(i.expires_at, ?)
      FROM email_signup_intents i WHERE i.id = ? AND i.purpose = 'signup'
      AND i.authority_hash = ? AND i.verified_at IS NOT NULL AND i.consumed_at IS NULL
      AND i.browser_binding_hash = ? AND i.expected_origin = ? AND i.expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM passkey_signup_pending p WHERE p.intent_id = i.id)
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = i.email COLLATE NOCASE)
    RETURNING *`)
    .bind(
      crypto.randomUUID(),
      crypto.randomUUID(),
      generateToken(32),
      generateToken(32),
      c.rpId,
      c.now + 300,
      input.intentId,
      c.authorityHash,
      c.browserHash,
      c.origin,
      c.now,
    )
    .first<PendingEmailPasskeySignup>();
}

/** Resume the SAME live enrollment; expiry requires a fresh email intent. */
export async function findPendingEmailPasskeySignup(
  db: D1Database,
  input: EmailSignupAuthority & { pendingId: string },
): Promise<PendingEmailPasskeySignup | null> {
  const c = await context(input);
  return db
    .prepare(`SELECT p.* FROM passkey_signup_pending p JOIN email_signup_intents i ON i.id = p.intent_id
    WHERE p.id = ? AND i.id = ? AND i.authority_hash = ? AND i.verified_at IS NOT NULL AND i.consumed_at IS NULL
      AND p.browser_binding_hash = ? AND i.browser_binding_hash = p.browser_binding_hash
      AND p.expected_origin = ? AND i.expected_origin = p.expected_origin AND p.rp_id = ?
      AND p.expires_at > ? AND i.expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = i.email COLLATE NOCASE)`)
    .bind(
      input.pendingId,
      input.intentId,
      c.authorityHash,
      c.browserHash,
      c.origin,
      c.rpId,
      c.now,
      c.now,
    )
    .first<PendingEmailPasskeySignup>();
}

/** All key metadata MUST come from the audited verifier, not a browser DTO. */
export interface VerifiedSignupCredential {
  verified: true;
  ownerID: string;
  webAuthnUserID: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  transports?: readonly string[];
}
export interface SignupCommitReceipt {
  registrationId: string;
  credentialId: string;
}
export type SignupCommitOutcome =
  | { status: "created"; userId: string; receipt: SignupCommitReceipt }
  | { status: "not_created" }
  | { status: "uncertain"; receipt: SignupCommitReceipt };

/**
 * No session or OAuth code is issued here. The initial and final NOT NULL guards
 * abort the WHOLE batch for invalid authority or unexpected core zero-row statements.
 * Guard cleanup anomalies return uncertain after commit and cannot authorize a retry.
 * Uncertain transport results must be reconciled; never retry by creating another
 * user or treat authority/receipt possession as an authenticated login.
 */
export async function completeVerifiedEmailPasskeySignup(
  db: D1Database,
  input: EmailSignupAuthority & {
    pendingId: string;
    challenge: string;
    name: string;
    credential: VerifiedSignupCredential;
  },
): Promise<SignupCommitOutcome> {
  const v = input.credential;
  if (
    v.verified !== true ||
    !/^[A-Za-z0-9_-]{1,2048}$/.test(v.credentialId) ||
    !/^[A-Za-z0-9_-]{1,8192}$/.test(v.publicKey) ||
    !Number.isInteger(v.counter) ||
    v.counter < 0 ||
    v.counter > 0xffffffff ||
    !input.name.trim() ||
    input.name.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(input.name) ||
    !SECRET_RE.test(input.challenge) ||
    !SECRET_RE.test(v.webAuthnUserID) ||
    !["singleDevice", "multiDevice"].includes(v.deviceType) ||
    typeof v.backedUp !== "boolean" ||
    (v.transports ?? []).some(
      (t) => !["usb", "nfc", "ble", "internal", "hybrid", "smart-card"].includes(t),
    )
  )
    return { status: "not_created" };
  const c = await context(input);
  const guardId = crypto.randomUUID();
  const assertionId = crypto.randomUUID();
  const receipt = { registrationId: crypto.randomUUID(), credentialId: v.credentialId };
  try {
    const results = await db.batch([
      db
        .prepare(`INSERT INTO passkey_signup_commit_guards (id, proof) VALUES (?,
        (SELECT 'pending:' || p.id FROM passkey_signup_pending p JOIN email_signup_intents i ON i.id = p.intent_id
         WHERE p.id = ? AND p.challenge = ? AND p.user_id = ? AND p.webauthn_user_id = ?
           AND i.id = ? AND i.purpose = 'signup' AND i.authority_hash = ?
           AND i.verified_at IS NOT NULL AND i.consumed_at IS NULL
           AND p.browser_binding_hash = ? AND i.browser_binding_hash = p.browser_binding_hash
           AND p.expected_origin = ? AND i.expected_origin = p.expected_origin AND p.rp_id = ?
           AND p.expires_at > ? AND i.expires_at > ?
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = i.email COLLATE NOCASE)))`)
        .bind(
          guardId,
          input.pendingId,
          input.challenge,
          v.ownerID,
          v.webAuthnUserID,
          input.intentId,
          c.authorityHash,
          c.browserHash,
          c.origin,
          c.rpId,
          c.now,
          c.now,
        ),
      db
        .prepare(`INSERT INTO users (id, email, email_verified, name, role)
        SELECT p.user_id, i.email, 1, ?, 'user' FROM passkey_signup_pending p
          JOIN email_signup_intents i ON i.id = p.intent_id
          JOIN passkey_signup_commit_guards g ON g.proof = 'pending:' || p.id WHERE g.id = ?`)
        .bind(input.name.trim(), guardId),
      db
        .prepare(`INSERT INTO passkey_user_handles (user_id, webauthn_user_id)
        SELECT p.user_id, p.webauthn_user_id FROM passkey_signup_pending p
          JOIN passkey_signup_commit_guards g ON g.proof = 'pending:' || p.id WHERE g.id = ?`)
        .bind(guardId),
      db
        .prepare(`INSERT INTO passkey_credentials
        (credential_id, registration_id, user_id, public_key, sign_count, transports_json, device_type, backed_up, created_at)
        SELECT ?, ?, p.user_id, ?, ?, ?, ?, ?, ? FROM passkey_signup_pending p
          JOIN passkey_signup_commit_guards g ON g.proof = 'pending:' || p.id WHERE g.id = ?`)
        .bind(
          v.credentialId,
          receipt.registrationId,
          v.publicKey,
          v.counter,
          JSON.stringify(v.transports ?? []),
          v.deviceType,
          v.backedUp ? 1 : 0,
          c.now,
          guardId,
        ),
      db
        .prepare(`UPDATE email_signup_intents SET consumed_at = ? WHERE id IN
        (SELECT p.intent_id FROM passkey_signup_pending p JOIN passkey_signup_commit_guards g ON g.proof = 'pending:' || p.id WHERE g.id = ?)`)
        .bind(c.now, guardId),
      db
        .prepare(`DELETE FROM passkey_signup_pending WHERE 'pending:' || id =
        (SELECT proof FROM passkey_signup_commit_guards WHERE id = ?)`)
        .bind(guardId),
      db
        .prepare(`INSERT INTO passkey_signup_commit_guards (id, proof) VALUES (?,
        (SELECT 'completed:' || c.registration_id FROM passkey_credentials c
          JOIN users u ON u.id = c.user_id JOIN passkey_user_handles h ON h.user_id = u.id
          JOIN email_signup_intents i ON i.email = u.email
          WHERE c.registration_id = ? AND c.credential_id = ? AND c.user_id = ?
            AND i.id = ? AND i.consumed_at = ? AND u.email_verified = 1 AND u.role = 'user'
            AND h.webauthn_user_id = ?
            AND NOT EXISTS (SELECT 1 FROM passkey_signup_pending p WHERE p.id = ?)))`)
        .bind(
          assertionId,
          receipt.registrationId,
          v.credentialId,
          v.ownerID,
          input.intentId,
          c.now,
          v.webAuthnUserID,
          input.pendingId,
        ),
      db
        .prepare("DELETE FROM passkey_signup_commit_guards WHERE id IN (?, ?)")
        .bind(guardId, assertionId),
    ]);
    return results.slice(0, 7).every((r) => r.meta.changes === 1) && results[7].meta.changes === 2
      ? { status: "created", userId: v.ownerID, receipt }
      : { status: "uncertain", receipt };
  } catch {
    return { status: "uncertain", receipt };
  }
}

/** Read-only reconciliation, NOT proof of authentication or permission to issue tokens.
 * null is NOT proof that no commit occurred: ban, deletion or verification revocation also hide a row. */
export async function reconcileEmailPasskeySignup(
  db: D1Database,
  receipt: SignupCommitReceipt,
): Promise<{ userId: string } | null> {
  return db
    .prepare(`SELECT c.user_id AS userId FROM passkey_credentials c JOIN users u ON u.id = c.user_id
    WHERE c.registration_id = ? AND c.credential_id = ? AND u.email_verified = 1 AND u.banned_at IS NULL`)
    .bind(receipt.registrationId, receipt.credentialId)
    .first<{ userId: string }>();
}
