/**
 * RP profile disclosure stays disabled until a per-user, per-client consent contract exists.
 * These projections accept only the already computed pairwise subject, never a User record.
 */
export function createRelyingPartyClaims(sub: string): { sub: string } {
  return { sub };
}

/** Preserve the legacy user.id field without exposing the internal user UUID. */
export function createLegacyRelyingPartyUser(sub: string): { id: string } {
  return { id: sub };
}
