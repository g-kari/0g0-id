/**
 * Persistence only, not a WebAuthn verifier. All inputs must come from a verified
 * ceremony, never the raw JSON sent by a browser. Nothing is publicly mounted.
 */
export interface PasskeyCredential {
  credential_id: string;
  /** Immutable server-generated enrollment generation; prevents delete/reinsert ABA. */
  registration_id: string;
  user_id: string;
  /** Base64url-encoded COSE public key, not a private key or a JWK secret. */
  public_key: string;
  sign_count: number;
  transports_json: string;
  device_type: "singleDevice" | "multiDevice";
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
}

function validateCounter(counter: number): void {
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffffffff) {
    throw new Error("Invalid passkey signature counter");
  }
}

/** Never upsert: a credential ID belonging to another account must stay there. */
export async function storeVerifiedPasskey(
  db: D1Database,
  input: {
    credentialId: string;
    userId: string;
    publicKey: string;
    counter: number;
    deviceType: "singleDevice" | "multiDevice";
    backedUp: boolean;
  },
): Promise<PasskeyCredential | null> {
  validateCounter(input.counter);
  return db
    .prepare(
      `INSERT INTO passkey_credentials
         (credential_id, registration_id, user_id, public_key, sign_count, device_type, backed_up, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND email_verified = 1 AND banned_at IS NULL)
       RETURNING *`,
    )
    .bind(
      input.credentialId,
      crypto.randomUUID(),
      input.userId,
      input.publicKey,
      input.counter,
      input.deviceType,
      input.backedUp ? 1 : 0,
      Math.floor(Date.now() / 1000),
      input.userId,
    )
    .first<PasskeyCredential>();
}

/** In an email-first flow, userId is the matched account, not a posted user ID. */
export async function findPasskeyCredential(
  db: D1Database,
  input: { credentialId: string; userId: string },
): Promise<PasskeyCredential | null> {
  return db
    .prepare("SELECT * FROM passkey_credentials WHERE credential_id = ? AND user_id = ?")
    .bind(input.credentialId, input.userId)
    .first<PasskeyCredential>();
}

/**
 * Call only after a successful verifier result and atomic challenge claim. The
 * compare-and-swap rejects a changed nonzero counter or a missing credential.
 * A zero counter is not a version number: replay protection comes from the
 * challenge claim. The immutable enrollment generation rejects snapshots from
 * a deleted/reinserted credential, including zero-counter authenticators.
 * A nonzero counter must increase; a rollback never silently enables zero-mode.
 */
export async function recordVerifiedPasskeyAuthentication(
  db: D1Database,
  input: {
    credentialId: string;
    registrationId: string;
    userId: string;
    previousCounter: number;
    newCounter: number;
  },
): Promise<boolean> {
  validateCounter(input.previousCounter);
  validateCounter(input.newCounter);
  if (
    input.newCounter <= input.previousCounter &&
    (input.previousCounter !== 0 || input.newCounter !== 0)
  ) {
    return false;
  }
  const row = await db
    .prepare(
      `UPDATE passkey_credentials SET sign_count = ?, last_used_at = ?
        WHERE credential_id = ? AND registration_id = ? AND user_id = ? AND sign_count = ?
          AND EXISTS (SELECT 1 FROM users WHERE id = ? AND email_verified = 1 AND banned_at IS NULL)
       RETURNING credential_id`,
    )
    .bind(
      input.newCounter,
      Math.floor(Date.now() / 1000),
      input.credentialId,
      input.registrationId,
      input.userId,
      input.previousCounter,
      input.userId,
    )
    .first<{ credential_id: string }>();
  return row !== null;
}
