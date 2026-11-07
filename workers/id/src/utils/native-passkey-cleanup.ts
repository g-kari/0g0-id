import { cleanupExpiredPasskeyChallenges } from "../../../../packages/shared/src/db/passkey-challenges";

/** Do not reference proposed tables in disabled deployments. Schema absence is
 * an explicit incomplete result, never a successful cleanup or runtime enable. */
export async function cleanupNativePasskeyChallenges(db: D1Database, enabled: unknown) {
  if (enabled !== "true") return { status: "disabled" as const };
  const table = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'passkey_challenges'")
    .first<{ name: string }>();
  if (!table) return { status: "schema_missing" as const };
  await cleanupExpiredPasskeyChallenges(db);
  return { status: "completed" as const };
}
