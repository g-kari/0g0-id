import { generateToken, sha256 } from "../lib/crypto";

/** Storage primitives only. No public route may use these without WebAuthn verification. */
export type PasskeyCeremony = "registration" | "authentication";

export interface PasskeyChallenge {
  id: string;
  challenge: string;
  ceremony: PasskeyCeremony;
  user_id: string | null;
  browser_binding_hash: string;
  expected_origin: string;
  rp_id: string;
  expires_at: number;
}

export interface PasskeyChallengeBinding {
  id: string;
  ceremony: PasskeyCeremony;
  userId: string | null;
  /** A fresh, 32-byte random __Host- cookie. Never accept a request-body value here. */
  browserBinding: string;
  /** Server configuration, never the Host/Origin header supplied by a request. */
  idpOrigin: string;
}

const BINDING_RE = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE_TTL_SECONDS = 300;

/** Keep credentials scoped to the IdP host, not every application on 0g0.xyz. */
export function passkeyRelyingParty(idpOrigin: string): { origin: string; rpId: string } {
  const url = new URL(idpOrigin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname.endsWith(".") ||
    url.hostname.includes("*") ||
    !url.hostname.includes(".") ||
    /^[\d.]+$/.test(url.hostname) ||
    url.hostname.includes(":")
  ) {
    throw new Error("Passkeys require a configured HTTPS DNS origin");
  }
  return { origin: url.origin, rpId: url.hostname };
}

function validateBinding(input: Omit<PasskeyChallengeBinding, "id">): void {
  if (input.ceremony !== "registration" && input.ceremony !== "authentication") {
    throw new Error("Invalid passkey ceremony");
  }
  if (!BINDING_RE.test(input.browserBinding)) {
    throw new Error("Invalid browser binding");
  }
  if (
    (input.ceremony === "registration" && !input.userId) ||
    (input.userId !== null && (!input.userId || input.userId.length > 128))
  ) {
    throw new Error("Registration requires a verified user");
  }
}

/**
 * The caller must first verify email ownership (new account) or require a fresh
 * authenticated session (existing account). A typed email is never that proof.
 * Registration subject existence/verification is also enforced in the INSERT.
 */
export async function issuePasskeyChallenge(
  db: D1Database,
  input: Omit<PasskeyChallengeBinding, "id">,
): Promise<PasskeyChallenge | null> {
  validateBinding(input);
  const rp = passkeyRelyingParty(input.idpOrigin);
  const now = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `INSERT INTO passkey_challenges
         (id, challenge, ceremony, user_id, browser_binding_hash, expected_origin, rp_id, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ? = 'authentication'
           OR EXISTS (SELECT 1 FROM users WHERE id = ? AND email_verified = 1 AND banned_at IS NULL)
       RETURNING *`,
    )
    .bind(
      crypto.randomUUID(),
      generateToken(32),
      input.ceremony,
      input.userId,
      await sha256(input.browserBinding),
      rp.origin,
      rp.rpId,
      now + CHALLENGE_TTL_SECONDS,
      input.ceremony,
      input.userId,
    )
    .first<PasskeyChallenge>();
}

/**
 * Read the challenge to pass to an audited WebAuthn verifier. A successful read
 * does not authorize a login or credential write. Call consume after successful
 * signature, RP ID, origin, challenge, type, UP and required UV verification.
 */
export async function findPasskeyChallenge(
  db: D1Database,
  input: PasskeyChallengeBinding,
): Promise<PasskeyChallenge | null> {
  validateBinding(input);
  const rp = passkeyRelyingParty(input.idpOrigin);
  return db
    .prepare(
      `SELECT * FROM passkey_challenges
        WHERE id = ? AND ceremony = ? AND user_id IS ?
          AND browser_binding_hash = ? AND expected_origin = ? AND rp_id = ?
          AND expires_at > ?`,
    )
    .bind(
      input.id,
      input.ceremony,
      input.userId,
      await sha256(input.browserBinding),
      rp.origin,
      rp.rpId,
      Math.floor(Date.now() / 1000),
    )
    .first<PasskeyChallenge>();
}

/**
 * Atomically claim a verified ceremony. Exactly one concurrent completion wins.
 * No tokens or credential writes may happen unless a row is returned. Failure
 * after this claim requires a new ceremony, never replay of a previous response.
 */
export async function consumePasskeyChallenge(
  db: D1Database,
  input: PasskeyChallengeBinding,
): Promise<PasskeyChallenge | null> {
  validateBinding(input);
  const rp = passkeyRelyingParty(input.idpOrigin);
  return db
    .prepare(
      `DELETE FROM passkey_challenges
        WHERE id = ? AND ceremony = ? AND user_id IS ?
          AND browser_binding_hash = ? AND expected_origin = ? AND rp_id = ?
          AND expires_at > ?
       RETURNING *`,
    )
    .bind(
      input.id,
      input.ceremony,
      input.userId,
      await sha256(input.browserBinding),
      rp.origin,
      rp.rpId,
      Math.floor(Date.now() / 1000),
    )
    .first<PasskeyChallenge>();
}

/** Called only once the proposed schema is deployed. */
export async function cleanupExpiredPasskeyChallenges(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM passkey_challenges WHERE expires_at <= ?")
    .bind(Math.floor(Date.now() / 1000))
    .run();
}
