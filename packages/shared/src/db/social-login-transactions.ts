import { sha256 } from "../lib/crypto";

export interface SocialLoginTransactionBinding {
  state: string;
  /** Fresh 32-byte browser cookie value (the PKCE verifier), never request input. */
  browserBinding: string;
  /** Exact signed state JSON, without reparsing or reserialization. */
  statePayload: string;
  provider: "discord" | "steam";
  /** Exact canonical HTTPS origin from trusted server configuration. */
  idpOrigin: string;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

async function bindingValues(input: SocialLoginTransactionBinding) {
  if (!TOKEN_RE.test(input.state) || !TOKEN_RE.test(input.browserBinding)) {
    throw new Error("Invalid social login transaction binding");
  }
  if (input.provider !== "discord" && input.provider !== "steam") {
    throw new Error("Invalid social login provider");
  }
  if (typeof input.statePayload !== "string" || !input.statePayload) {
    throw new Error("Missing signed social login state payload");
  }
  const origin = new URL(input.idpOrigin);
  if (origin.protocol !== "https:" || origin.origin !== input.idpOrigin) {
    throw new Error("Social login requires an exact configured HTTPS origin");
  }
  return [
    await sha256(input.state),
    await sha256(input.browserBinding),
    await sha256(input.statePayload),
    input.provider,
    input.idpOrigin,
  ];
}

/** No raw state, signed payload or PKCE verifier is persisted. Expiry uses D1's clock. */
export async function issueSocialLoginTransaction(
  db: D1Database,
  input: SocialLoginTransactionBinding,
): Promise<void> {
  const values = await bindingValues(input);
  await db
    .prepare(`INSERT INTO social_login_transactions
    (state_hash, browser_binding_hash, state_payload_hash, provider, idp_origin, expires_at)
    VALUES (?, ?, ?, ?, ?, unixepoch() + 600)`)
    .bind(...values)
    .run();
}

/**
 * Claim before upstream verification. Only a returned row authorizes continuing.
 * Errors (including uncertain execution) propagate: never retry a failed claim.
 */
export async function consumeSocialLoginTransaction(
  db: D1Database,
  input: SocialLoginTransactionBinding,
): Promise<boolean> {
  const values = await bindingValues(input);
  const row = await db
    .prepare(`DELETE FROM social_login_transactions
    WHERE state_hash = ? AND browser_binding_hash = ? AND state_payload_hash = ?
      AND provider = ? AND idp_origin = ? AND expires_at > unixepoch()
    RETURNING state_hash`)
    .bind(...values)
    .first<{ state_hash: string }>();
  return row !== null;
}

/** Atomic replay claim. An expired nonce is rejected using the database clock. */
export async function consumeSteamLoginNonce(
  db: D1Database,
  nonceHash: string,
  expiresAtMs: number,
): Promise<boolean> {
  if (
    !/^[a-f0-9]{64}$/.test(nonceHash) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= 0 ||
    expiresAtMs > 8_640_000_000_000_000
  ) {
    throw new Error("Invalid Steam nonce binding or expiry");
  }
  const expiresAt = Math.floor(expiresAtMs / 1000);
  const row = await db
    .prepare(`INSERT INTO steam_login_nonces (nonce_hash, expires_at)
    SELECT ?, ? WHERE ? > unixepoch()
    ON CONFLICT(nonce_hash) DO NOTHING RETURNING nonce_hash`)
    .bind(nonceHash, expiresAt, expiresAt)
    .first<{ nonce_hash: string }>();
  return row !== null;
}

/** Claim a verified, two-minute linking token exactly once before changing an account. */
export async function consumeSocialLoginLinkToken(
  db: D1Database,
  jti: string,
  expiresAtMs: number,
): Promise<boolean> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jti) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= 0 ||
    expiresAtMs > 8_640_000_000_000_000
  ) {
    throw new Error("Invalid social login link token binding or expiry");
  }
  const expiresAt = Math.floor(expiresAtMs / 1000);
  const row = await db
    .prepare(`INSERT INTO social_login_link_nonces (jti_hash, expires_at)
    SELECT ?, ? WHERE ? > unixepoch() AND ? <= unixepoch() + 120
    ON CONFLICT(jti_hash) DO NOTHING RETURNING jti_hash`)
    .bind(await sha256(jti.toLowerCase()), expiresAt, expiresAt, expiresAt)
    .first<{ jti_hash: string }>();
  return row !== null;
}

/** Missing schema and operational failures both disable login, never authorize it. */
export async function socialLoginSchemaReady(db: D1Database): Promise<boolean> {
  try {
    // Scalar subqueries resolve every required column even when the tables are empty.
    const row = await db
      .prepare(`SELECT 1 AS ready,
      (SELECT discord_sub FROM users LIMIT 0), (SELECT steam_sub FROM users LIMIT 0),
      (SELECT state_hash FROM social_login_transactions LIMIT 0),
      (SELECT browser_binding_hash FROM social_login_transactions LIMIT 0),
      (SELECT state_payload_hash FROM social_login_transactions LIMIT 0),
      (SELECT provider FROM social_login_transactions LIMIT 0),
      (SELECT idp_origin FROM social_login_transactions LIMIT 0),
      (SELECT expires_at FROM social_login_transactions LIMIT 0),
      (SELECT nonce_hash FROM steam_login_nonces LIMIT 0),
      (SELECT expires_at FROM steam_login_nonces LIMIT 0),
      (SELECT jti_hash FROM social_login_link_nonces LIMIT 0),
      (SELECT expires_at FROM social_login_link_nonces LIMIT 0)`)
      .bind()
      .first<{ ready: number }>();
    return row?.ready === 1;
  } catch {
    return false;
  }
}

/** Call only when the feature gates and schema readiness checks permit it. */
export async function cleanupSocialLoginTransactions(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM social_login_transactions WHERE expires_at <= unixepoch()")
    .bind()
    .run();
  await db.prepare("DELETE FROM steam_login_nonces WHERE expires_at <= unixepoch()").bind().run();
  await db
    .prepare("DELETE FROM social_login_link_nonces WHERE expires_at <= unixepoch()")
    .bind()
    .run();
}
