import type { User } from "../types";
import { ALL_PROVIDERS, PROVIDER_COLUMN, type OAuthProvider } from "../lib/providers";

type SocialLoginProvider = "discord" | "steam";

function subjectColumn(provider: SocialLoginProvider, sub: string): "discord_sub" | "steam_sub" {
  if (provider !== "discord" && provider !== "steam")
    throw new Error("Invalid social login provider");
  if (
    typeof sub !== "string" ||
    (provider === "discord"
      ? !/^[1-9][0-9]{0,19}$/.test(sub) || BigInt(sub) > 18_446_744_073_709_551_615n
      : !/^[1-9][0-9]{16}$/.test(sub))
  ) {
    throw new Error("Invalid social login subject");
  }
  return provider === "discord" ? "discord_sub" : "steam_sub";
}

/** Stable provider subjects alone identify accounts; provider emails never link accounts. */
export async function upsertSocialLoginUser(
  db: D1Database,
  input: {
    id: string;
    provider: SocialLoginProvider;
    sub: string;
    name: string;
    picture: string | null;
  },
): Promise<User> {
  const column = subjectColumn(input.provider, input.sub);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)) {
    throw new Error("Social login requires a generated account UUID");
  }
  const user = await db
    .prepare(`INSERT INTO users
    (id, ${column}, email, email_verified, name, picture)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(${column}) WHERE ${column} IS NOT NULL DO UPDATE SET
      name = excluded.name, picture = excluded.picture,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE users.banned_at IS NULL
    RETURNING *`)
    .bind(
      input.id,
      input.sub,
      `${input.id.toLowerCase()}@${input.provider}.invalid`,
      input.name,
      input.picture,
    )
    .first<User>();
  if (!user) throw new Error("ACCOUNT_UNAVAILABLE");
  return user;
}

/**
 * Caller must consume a valid browser-bound, signed single-use linking token first.
 * A conditional atomic write cannot replace an occupied identity or link banned users.
 * Failed/uncertain writes propagate without retries; follow-up reads only classify no-op.
 */
export async function linkSocialLoginUser(
  db: D1Database,
  userId: string,
  provider: SocialLoginProvider,
  sub: string,
): Promise<User> {
  const column = subjectColumn(provider, sub);
  const user = await db
    .prepare(`UPDATE users SET ${column} = ?,
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ? AND banned_at IS NULL AND (${column} IS NULL OR ${column} = ?)
      AND NOT EXISTS (SELECT 1 FROM users other WHERE other.${column} = ? AND other.id <> ?)
    RETURNING *`)
    .bind(sub, userId, sub, sub, userId)
    .first<User>();
  if (user) return user;
  const target = await db
    .prepare("SELECT id FROM users WHERE id = ? AND banned_at IS NULL")
    .bind(userId)
    .first<{ id: string }>();
  if (!target) throw new Error("ACCOUNT_UNAVAILABLE");
  throw new Error("PROVIDER_ALREADY_LINKED");
}

/** Full social schema is required. Never allow concurrent unlinks to remove the last factor. */
export async function unlinkSocialLoginProvider(
  db: D1Database,
  userId: string,
  provider: OAuthProvider,
): Promise<boolean> {
  if (!ALL_PROVIDERS.includes(provider)) throw new Error("Invalid social login provider");
  const column = PROVIDER_COLUMN[provider];
  const remaining = ALL_PROVIDERS.filter((other) => other !== provider)
    .map((other) => `${PROVIDER_COLUMN[other]} IS NOT NULL`)
    .join(" OR ");
  const row = await db
    .prepare(`UPDATE users SET ${column} = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ? AND banned_at IS NULL AND ${column} IS NOT NULL AND (${remaining})
    RETURNING id`)
    .bind(userId)
    .first<{ id: string }>();
  return row !== null;
}
