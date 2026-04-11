import type { User } from "../types";
import { escapeLikePattern } from "../lib/sql";
import { daysAgoIso } from "./helpers";
import {
  type OAuthProvider,
  PROVIDER_COLUMN,
  PROVIDER_DISPLAY_NAMES,
  ALL_PROVIDERS,
} from "../lib/providers";

export async function findUserById(db: D1Database, id: string): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

const ALLOWED_PROVIDER_COLUMNS = new Set(Object.values(PROVIDER_COLUMN));

/** プロバイダー名からカラム名を取得し、不正なプロバイダーなら例外を投げる */
function validateProviderColumn(provider: OAuthProvider): string {
  const col = PROVIDER_COLUMN[provider];
  if (!col || !ALLOWED_PROVIDER_COLUMNS.has(col)) {
    throw new Error(`Invalid provider: ${provider}`);
  }
  return col;
}

export async function findUserBySub(
  db: D1Database,
  provider: OAuthProvider,
  sub: string,
): Promise<User | null> {
  const col = validateProviderColumn(provider);
  return db.prepare(`SELECT * FROM users WHERE ${col} = ?`).bind(sub).first<User>();
}

export async function findUserByEmail(db: D1Database, email: string): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<User>();
}

async function upsertProviderUser(
  db: D1Database,
  opts: {
    id: string;
    provider: OAuthProvider;
    subValue: string;
    email: string;
    name: string;
    picture: string | null;
    // undefined: プロフィール更新時にemailを更新しない（Google以外）
    profileEmailUpdate: { email: string; emailVerified: boolean } | undefined;
    // undefined: メール連携しない（X）/ {}: email_verifiedを更新しない / { emailVerified }: 更新する（Google）
    emailLink: { emailVerified?: boolean } | undefined;
    newUserEmailVerified: boolean;
  },
): Promise<User> {
  const subColumn = validateProviderColumn(opts.provider);
  const providerLabel = PROVIDER_DISPLAY_NAMES[opts.provider];
  // 既存ユーザー（同プロバイダー）のプロフィール更新
  const existingBySub = await findUserBySub(db, opts.provider, opts.subValue);
  if (existingBySub) {
    if (opts.profileEmailUpdate) {
      const user = await db
        .prepare(
          `UPDATE users SET email = ?, email_verified = ?, name = ?, picture = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? RETURNING *`,
        )
        .bind(
          opts.profileEmailUpdate.email,
          opts.profileEmailUpdate.emailVerified ? 1 : 0,
          opts.name,
          opts.picture,
          existingBySub.id,
        )
        .first<User>();
      if (!user) throw new Error(`Failed to update ${providerLabel} user`);
      return user;
    }
    const user = await db
      .prepare(
        `UPDATE users SET name = ?, picture = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? RETURNING *`,
      )
      .bind(opts.name, opts.picture, existingBySub.id)
      .first<User>();
    if (!user) throw new Error(`Failed to update ${providerLabel} user`);
    return user;
  }

  // 同メールの既存ユーザーにプロバイダーを連携
  if (opts.emailLink !== undefined) {
    const existingByEmail = await findUserByEmail(db, opts.email);
    if (existingByEmail) {
      let sql: string;
      let bindings: unknown[];
      if (opts.emailLink.emailVerified !== undefined) {
        sql = `UPDATE users SET ${subColumn} = ?, email_verified = ?, name = ?, picture = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? RETURNING *`;
        bindings = [
          opts.subValue,
          opts.emailLink.emailVerified ? 1 : 0,
          opts.name,
          opts.picture,
          existingByEmail.id,
        ];
      } else {
        sql = `UPDATE users SET ${subColumn} = ?, name = ?, picture = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? RETURNING *`;
        bindings = [opts.subValue, opts.name, opts.picture, existingByEmail.id];
      }
      const user = await db
        .prepare(sql)
        .bind(...bindings)
        .first<User>();
      if (!user) throw new Error(`Failed to link ${providerLabel} account`);
      return user;
    }
  }

  // 新規ユーザー作成
  const user = await db
    .prepare(
      `INSERT INTO users (id, ${subColumn}, email, email_verified, name, picture) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      opts.id,
      opts.subValue,
      opts.email,
      opts.newUserEmailVerified ? 1 : 0,
      opts.name,
      opts.picture,
    )
    .first<User>();
  if (!user) throw new Error(`Failed to create ${providerLabel} user`);
  return user;
}

export async function upsertUser(
  db: D1Database,
  params: {
    id: string;
    googleSub: string;
    email: string;
    emailVerified: boolean;
    name: string;
    picture: string | null;
  },
): Promise<User> {
  return upsertProviderUser(db, {
    id: params.id,
    provider: "google",
    subValue: params.googleSub,
    email: params.email,
    name: params.name,
    picture: params.picture,
    profileEmailUpdate: { email: params.email, emailVerified: params.emailVerified },
    emailLink: { emailVerified: params.emailVerified },
    newUserEmailVerified: params.emailVerified,
  });
}

export async function upsertLineUser(
  db: D1Database,
  params: {
    id: string;
    lineSub: string;
    email: string;
    isPlaceholderEmail: boolean;
    name: string;
    picture: string | null;
  },
): Promise<User> {
  return upsertProviderUser(db, {
    id: params.id,
    provider: "line",
    subValue: params.lineSub,
    email: params.email,
    name: params.name,
    picture: params.picture,
    profileEmailUpdate: undefined,
    emailLink: params.isPlaceholderEmail ? undefined : {},
    newUserEmailVerified: !params.isPlaceholderEmail,
  });
}

export async function upsertTwitchUser(
  db: D1Database,
  params: {
    id: string;
    twitchSub: string;
    email: string;
    isPlaceholderEmail: boolean;
    emailVerified: boolean;
    name: string;
    picture: string | null;
  },
): Promise<User> {
  return upsertProviderUser(db, {
    id: params.id,
    provider: "twitch",
    subValue: params.twitchSub,
    email: params.email,
    name: params.name,
    picture: params.picture,
    profileEmailUpdate: undefined,
    emailLink: params.isPlaceholderEmail ? undefined : {},
    newUserEmailVerified: !params.isPlaceholderEmail && params.emailVerified,
  });
}

export async function upsertGithubUser(
  db: D1Database,
  params: {
    id: string;
    githubSub: string;
    email: string;
    isPlaceholderEmail: boolean;
    name: string;
    picture: string | null;
  },
): Promise<User> {
  return upsertProviderUser(db, {
    id: params.id,
    provider: "github",
    subValue: params.githubSub,
    email: params.email,
    name: params.name,
    picture: params.picture,
    profileEmailUpdate: undefined,
    emailLink: params.isPlaceholderEmail ? undefined : {},
    newUserEmailVerified: !params.isPlaceholderEmail,
  });
}

export async function upsertXUser(
  db: D1Database,
  params: {
    id: string;
    xSub: string;
    email: string; // X APIは有料プランでないとメール取得不可のため常に仮メール
    isPlaceholderEmail: boolean;
    name: string;
    picture: string | null;
  },
): Promise<User> {
  return upsertProviderUser(db, {
    id: params.id,
    provider: "x",
    subValue: params.xSub,
    email: params.email,
    name: params.name,
    picture: params.picture,
    profileEmailUpdate: undefined,
    emailLink: params.isPlaceholderEmail ? undefined : {},
    newUserEmailVerified: !params.isPlaceholderEmail,
  });
}

export async function updateUserRole(
  db: D1Database,
  userId: string,
  role: "user" | "admin",
): Promise<User> {
  const user = await db
    .prepare(
      `UPDATE users SET role = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? RETURNING *`,
    )
    .bind(role, userId)
    .first<User>();
  if (!user) throw new Error("User not found");
  return user;
}

export async function deleteUser(db: D1Database, userId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * 管理者が0人の場合のみ、指定ユーザーを管理者に昇格する（原子的操作）
 * NOT EXISTS サブクエリにより countAdminUsers→updateUserRole の TOCTOU を排除。
 * @returns 昇格が行われた場合は true、既に管理者が存在する or 既に admin ロールの場合は false
 */
export async function tryBootstrapAdmin(db: D1Database, userId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users
         SET role = 'admin', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?
         AND role != 'admin'
         AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`,
    )
    .bind(userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateUserProfile(
  db: D1Database,
  userId: string,
  params: {
    name?: string;
    picture?: string | null;
    phone?: string | null;
    address?: string | null;
  },
): Promise<User> {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (params.name !== undefined) {
    setClauses.push("name = ?");
    values.push(params.name);
  }
  if ("picture" in params) {
    setClauses.push("picture = ?");
    values.push(params.picture ?? null);
  }
  if ("phone" in params) {
    setClauses.push("phone = ?");
    values.push(params.phone ?? null);
  }
  if ("address" in params) {
    setClauses.push("address = ?");
    values.push(params.address ?? null);
  }
  if (setClauses.length === 0) {
    throw new Error("No fields to update");
  }
  setClauses.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");
  values.push(userId);

  const user = await db
    .prepare(`UPDATE users SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`)
    .bind(...values)
    .first<User>();
  if (!user) throw new Error("User not found");
  return user;
}

export async function countAdminUsers(db: D1Database): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM users WHERE role = ?")
    .bind("admin")
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export interface UserFilter {
  email?: string;
  role?: "user" | "admin";
  name?: string;
  /** true: BAN済みのみ / false: BAN済み除外 / undefined: 全件 */
  banned?: boolean;
  /** メールアドレスまたは名前で部分一致OR検索 */
  search?: string;
}

function buildUserFilterClause(filter?: UserFilter): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.search) {
    // email OR name の部分一致検索
    conditions.push("(email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLikePattern(filter.search)}%`;
    params.push(pattern, pattern);
  }
  if (filter?.email) {
    conditions.push("email LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLikePattern(filter.email)}%`);
  }
  if (filter?.role) {
    conditions.push("role = ?");
    params.push(filter.role);
  }
  if (filter?.name) {
    conditions.push("name LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLikePattern(filter.name)}%`);
  }
  if (filter?.banned === true) {
    conditions.push("banned_at IS NOT NULL");
  } else if (filter?.banned === false) {
    conditions.push("banned_at IS NULL");
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

export async function listUsers(
  db: D1Database,
  limit: number = 50,
  offset: number = 0,
  filter?: UserFilter,
): Promise<User[]> {
  const { where, params } = buildUserFilterClause(filter);
  const result = await db
    .prepare(`SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...params, limit, offset)
    .all<User>();
  return result.results;
}

export async function countUsers(db: D1Database, filter?: UserFilter): Promise<number> {
  const { where, params } = buildUserFilterClause(filter);
  const result = await db
    .prepare(`SELECT COUNT(*) as count FROM users ${where}`)
    .bind(...params)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

// SNSプロバイダー管理

export interface ProviderStatus {
  provider: OAuthProvider;
  connected: boolean;
}

export async function getUserProviders(db: D1Database, userId: string): Promise<ProviderStatus[]> {
  const user = await findUserById(db, userId);
  if (!user) throw new Error("User not found");
  const providers = ALL_PROVIDERS;
  return providers.map((p) => ({
    provider: p,
    connected: user[PROVIDER_COLUMN[p] as keyof User] !== null,
  }));
}

export async function unlinkProvider(
  db: D1Database,
  userId: string,
  provider: OAuthProvider,
): Promise<void> {
  const col = validateProviderColumn(provider);
  const result = await db
    .prepare(
      `UPDATE users SET ${col} = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
    )
    .bind(userId)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new Error("User not found");
}

export async function banUser(db: D1Database, userId: string): Promise<User> {
  const user = await db
    .prepare(
      `UPDATE users SET banned_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? RETURNING *`,
    )
    .bind(userId)
    .first<User>();
  if (!user) throw new Error("User not found");
  return user;
}

export async function unbanUser(db: D1Database, userId: string): Promise<User> {
  const user = await db
    .prepare(
      `UPDATE users SET banned_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? RETURNING *`,
    )
    .bind(userId)
    .first<User>();
  if (!user) throw new Error("User not found");
  return user;
}

/** 日別ユーザー登録数の統計エントリ */
export interface DailyUserRegistrationStat {
  date: string; // YYYY-MM-DD
  count: number;
}

/**
 * 指定日数分の日別新規ユーザー登録数を日付昇順で返す。
 * 登録が0件の日は結果に含まれない。
 */
export async function getDailyUserRegistrations(
  db: D1Database,
  days: number = 30,
): Promise<DailyUserRegistrationStat[]> {
  const sinceIso = daysAgoIso(days);
  const result = await db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at) as date, COUNT(*) as count
       FROM users
       WHERE created_at >= ?
       GROUP BY date
       ORDER BY date ASC`,
    )
    .bind(sinceIso)
    .all<DailyUserRegistrationStat>();
  return result.results;
}

export async function linkProvider(
  db: D1Database,
  userId: string,
  provider: OAuthProvider,
  sub: string,
): Promise<User> {
  // 他ユーザーが同サブIDを使用中か確認
  const existing = await findUserBySub(db, provider, sub);
  if (existing && existing.id !== userId) {
    throw new Error("PROVIDER_ALREADY_LINKED");
  }

  const col = validateProviderColumn(provider);
  let user: User | null;
  try {
    user = await db
      .prepare(
        `UPDATE users SET ${col} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? RETURNING *`,
      )
      .bind(sub, userId)
      .first<User>();
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      throw new Error("PROVIDER_ALREADY_LINKED");
    }
    throw err;
  }
  if (!user) throw new Error("User not found");
  return user;
}
