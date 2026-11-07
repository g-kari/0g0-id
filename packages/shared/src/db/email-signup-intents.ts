import { generateToken, sha256 } from "../lib/crypto";
import { passkeyRelyingParty } from "./passkey-challenges";

const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const TTL_SECONDS = 900;

export interface EmailSignupBinding {
  /** Server-read, fresh 32-byte __Host- cookie, never a submitted body field. */
  browserBinding: string;
  /** Trusted server configuration, never a request Host/Origin header. */
  idpOrigin: string;
}

export interface EmailSignupProof extends EmailSignupBinding {
  intentId: string;
  token: string;
}

export interface VerifiedEmailSignupIntent {
  id: string;
  email: string;
  expires_at: number;
}

/** Preserve local-part case; do not apply provider-specific dot/plus folding. */
function normalizeEmail(email: string): string {
  const parts = email.split("@");
  if (parts.length !== 2 || email.length > 254) throw new Error("Invalid email");
  const [local, domain] = parts;
  if (
    !local ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  )
    throw new Error("Invalid email");
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    /^[\d.]+$/.test(domain) ||
    labels.some(
      (label) => label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  )
    throw new Error("Invalid email");
  return `${local}@${domain.toLowerCase()}`;
}

async function binding(input: EmailSignupBinding): Promise<[string, string]> {
  if (!SECRET_RE.test(input.browserBinding)) throw new Error("Invalid browser binding");
  return [await sha256(input.browserBinding), passkeyRelyingParty(input.idpOrigin).origin];
}

/**
 * Atomic intent + non-resumable delivery ledger. The proof token is returned
 * only in memory for INTERNAL delivery; never return it from a signup API or
 * include it in logs/errors. It is never persisted as plaintext. A lost queued token is discarded,
 * not regenerated or automatically retried. External routes must always return
 * the same generic response, regardless of null/existing-user/rate-limit result.
 * DB caps complement, but do not replace, edge/IP/global abuse controls.
 */
export async function createEmailSignupIntent(
  db: D1Database,
  input: EmailSignupBinding & { email: string },
): Promise<{ intentId: string; recipient: string; token: string; expiresAt: number } | null> {
  const email = normalizeEmail(input.email);
  const [browserHash, origin] = await binding(input);
  const id = crypto.randomUUID();
  const token = generateToken(32);
  const now = Math.floor(Date.now() / 1000);
  const results = await db.batch([
    db
      .prepare(`INSERT INTO email_signup_intents
      (id, email, purpose, token_hash, browser_binding_hash, expected_origin, created_at, expires_at)
      SELECT ?, ?, 'signup', ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ? COLLATE NOCASE)
         AND (SELECT count(*) FROM email_signup_intents WHERE email = ? COLLATE NOCASE AND created_at >= ?) < 3
         AND (SELECT count(*) FROM email_signup_intents WHERE browser_binding_hash = ? AND created_at >= ?) < 5`)
      .bind(
        id,
        email,
        await sha256(token),
        browserHash,
        origin,
        now,
        now + TTL_SECONDS,
        email,
        email,
        now - 3600,
        browserHash,
        now - 3600,
      ),
    db
      .prepare(`INSERT INTO email_signup_outbox (intent_id, state, created_at)
      SELECT id, 'queued', created_at FROM email_signup_intents WHERE id = ?`)
      .bind(id),
  ]);
  return results[0].meta.changes === 1 && results[1].meta.changes === 1
    ? { intentId: id, recipient: email, token, expiresAt: now + TTL_SECONDS }
    : null;
}

/** Claim exactly once before calling the mail provider. Never reset to queued. */
export async function claimEmailSignupDelivery(
  db: D1Database,
  input: EmailSignupProof & { recipient: string },
): Promise<{ claimId: string; expiresAt: number } | null> {
  if (!SECRET_RE.test(input.token)) return null;
  const [browserHash, origin] = await binding(input);
  const claimId = crypto.randomUUID();
  const row = await db
    .prepare(`UPDATE email_signup_outbox
      SET state = 'claimed', claim_id = ?, claimed_at = ?
    WHERE intent_id = ? AND state = 'queued'
      AND EXISTS (SELECT 1 FROM email_signup_intents i
        WHERE i.id = email_signup_outbox.intent_id AND i.purpose = 'signup' AND i.email = ?
          AND i.token_hash = ? AND i.browser_binding_hash = ? AND i.expected_origin = ?
          AND i.verified_at IS NULL AND i.expires_at > ?)
    RETURNING (SELECT expires_at FROM email_signup_intents WHERE id = email_signup_outbox.intent_id) AS expires_at`)
    .bind(
      claimId,
      Math.floor(Date.now() / 1000),
      input.intentId,
      normalizeEmail(input.recipient),
      await sha256(input.token),
      browserHash,
      origin,
      Math.floor(Date.now() / 1000),
    )
    .first<{ expires_at: number }>();
  return row ? { claimId, expiresAt: row.expires_at } : null;
}

const REJECTION_CODES = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_ACCOUNT_SUSPENDED",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
]);
export type EmailSignupDeliveryResult =
  | { state: "accepted"; messageId: string }
  | { state: "rejected"; code: string }
  | { state: "uncertain" };

/** Immutable final result for this claim. Provider acceptance is not ownership. */
export async function finishEmailSignupDelivery(
  db: D1Database,
  intentId: string,
  claimId: string,
  result: EmailSignupDeliveryResult,
): Promise<boolean> {
  let messageId: string | null = null;
  let code: string | null = null;
  if (result.state === "accepted") {
    if (!/^[A-Za-z0-9._:@<>-]{1,254}$/.test(result.messageId)) return false;
    messageId = result.messageId;
  } else if (result.state === "rejected") {
    if (!REJECTION_CODES.has(result.code)) return false;
    code = result.code;
  } else if (result.state !== "uncertain") return false;
  const row = await db
    .prepare(`UPDATE email_signup_outbox
      SET state = ?, message_id = ?, rejection_code = ?, finalized_at = ?
    WHERE intent_id = ? AND claim_id = ? AND state = 'claimed' RETURNING intent_id`)
    .bind(result.state, messageId, code, Math.floor(Date.now() / 1000), intentId, claimId)
    .first<{ intent_id: string }>();
  return row !== null;
}

/**
 * A valid explicit browser-bound proof may succeed even after uncertain delivery.
 * Token consumption and authority installation happen in the SAME statement.
 * Only the winning call receives the authority; losing it requires a new intent.
 * This authorizes no login, user creation or linking to an existing OAuth user.
 */
export async function verifyEmailSignupIntent(
  db: D1Database,
  input: EmailSignupProof,
): Promise<(VerifiedEmailSignupIntent & { authority: string }) | null> {
  if (!SECRET_RE.test(input.token)) return null;
  const [browserHash, origin] = await binding(input);
  const authority = generateToken(32);
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(`UPDATE email_signup_intents
      SET verified_at = ?, token_hash = NULL, authority_hash = ?
    WHERE id = ? AND purpose = 'signup' AND token_hash = ? AND verified_at IS NULL
      AND browser_binding_hash = ? AND expected_origin = ? AND expires_at > ?
      AND EXISTS (SELECT 1 FROM email_signup_outbox o WHERE o.intent_id = email_signup_intents.id
        AND o.state IN ('claimed', 'accepted', 'uncertain'))
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = email_signup_intents.email COLLATE NOCASE)
    RETURNING id, email, expires_at`)
    .bind(
      now,
      await sha256(authority),
      input.intentId,
      await sha256(input.token),
      browserHash,
      origin,
      now,
    )
    .first<VerifiedEmailSignupIntent>();
  return row ? { ...row, authority } : null;
}

/** Read only; final user/credential creation MUST atomically consume authority. */
export async function findVerifiedEmailSignupIntent(
  db: D1Database,
  input: EmailSignupBinding & { intentId: string; authority: string },
): Promise<VerifiedEmailSignupIntent | null> {
  if (!SECRET_RE.test(input.authority)) return null;
  const [browserHash, origin] = await binding(input);
  return db
    .prepare(`SELECT id, email, expires_at FROM email_signup_intents
    WHERE id = ? AND authority_hash = ? AND verified_at IS NOT NULL
      AND consumed_at IS NULL AND browser_binding_hash = ? AND expected_origin = ? AND expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = email_signup_intents.email COLLATE NOCASE)`)
    .bind(
      input.intentId,
      await sha256(input.authority),
      browserHash,
      origin,
      Math.floor(Date.now() / 1000),
    )
    .first<VerifiedEmailSignupIntent>();
}

/** Crash recovery is fail-closed: never requeue an in-flight/unknown delivery. */
export async function settleAbandonedEmailSignupDeliveries(db: D1Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db
      .prepare(`UPDATE email_signup_outbox SET state = 'uncertain', finalized_at = ?
      WHERE state = 'claimed' AND claimed_at <= ?`)
      .bind(now, now - 60),
    db
      .prepare(`UPDATE email_signup_outbox SET state = 'discarded', finalized_at = ?
      WHERE state = 'queued' AND intent_id IN
        (SELECT id FROM email_signup_intents WHERE expires_at <= ?)`)
      .bind(now, now),
    // Retain one day after expiry, including rate-limit evidence; no scheduler is installed.
    db.prepare("DELETE FROM email_signup_intents WHERE expires_at <= ?").bind(now - 86400),
  ]);
}

export type EmailSignupSender = (message: {
  recipient: string;
  token: string;
  expiresAt: number;
}) => Promise<
  | { outcome: "accepted"; messageId: string }
  | { outcome: "rejected"; code: string }
  | { outcome: "disabled" | "not_configured" | "invalid_input" | "uncertain" }
>;

/**
 * Unconnected coordinator for an explicitly configured sender. The DB claim
 * precedes the only send invocation; losing a claim or a final DB write never
 * triggers another send. Pass sendVerificationEmail as the callback at future
 * integration, only after its approved configuration is ready.
 */
export async function deliverEmailSignupIntent(
  db: D1Database,
  input: EmailSignupProof & { recipient: string },
  send: EmailSignupSender,
): Promise<"not_claimed" | "accepted" | "rejected" | "uncertain"> {
  let claim: { claimId: string; expiresAt: number } | null;
  try {
    claim = await claimEmailSignupDelivery(db, input);
  } catch {
    return "uncertain";
  }
  if (!claim) return "not_claimed";
  let result: EmailSignupDeliveryResult = { state: "uncertain" };
  try {
    const sent = await send({
      recipient: normalizeEmail(input.recipient),
      token: input.token,
      expiresAt: claim.expiresAt,
    });
    if (sent.outcome === "accepted" && /^[A-Za-z0-9._:@<>-]{1,254}$/.test(sent.messageId)) {
      result = { state: "accepted", messageId: sent.messageId };
    } else if (sent.outcome === "rejected" && REJECTION_CODES.has(sent.code)) {
      result = { state: "rejected", code: sent.code };
    }
  } catch {
    // No raw provider data is logged or returned, and no retry is attempted.
  }
  try {
    return (await finishEmailSignupDelivery(db, input.intentId, claim.claimId, result))
      ? result.state
      : "uncertain";
  } catch {
    // The claim remains spent even if persisting the provider outcome fails.
    return "uncertain";
  }
}
