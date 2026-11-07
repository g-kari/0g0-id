import { settleAbandonedEmailSignupDeliveries } from "../../../../packages/shared/src/db/email-signup-intents";

/** No delivery retries. Keep the existing >1 UTC-day intent retention so that
 * cleanup cannot refund current-day allocations from the daily budget. */
export async function cleanupEmailPasskeyState(db: D1Database, enabled: unknown) {
  if (enabled !== "true") return { status: "disabled" as const };
  const tables = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('email_signup_intents','email_signup_outbox')",
    )
    .first<{ n: number }>();
  if (tables?.n !== 2) return { status: "schema_missing" as const };
  await settleAbandonedEmailSignupDeliveries(db);
  return { status: "completed" as const };
}
