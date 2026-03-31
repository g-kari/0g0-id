import type { User } from '../types';
import { type OAuthProvider, PROVIDER_COLUMN, PROVIDER_DISPLAY_NAMES, ALL_PROVIDERS } from '../lib/providers';

export async function findUserById(db: D1Database, id: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
}

export async function findUserByGoogleSub(db: D1Database, googleSub: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(googleSub).first<User>();
}

export async function findUserByLineSub(db: D1Database, lineSub: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE line_sub = ?').bind(lineSub).first<User>();
}

export async function findUserByTwitchSub(db: D1Database, twitchSub: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE twitch_sub = ?').bind(twitchSub).first<User>();
}

export async function findUserByGithubSub(
  db: D1Database,
  githubSub: string
): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE github_sub = ?').bind(githubSub).first<User>();
}

export async function findUserByXSub(db: D1Database, xSub: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE x_sub = ?').bind(xSub).first<User>();
}

export async function findUserByEmail(db: D1Database, email: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
}

async function upsertProviderUser(
  db: D1Database,
  opts: {
    id: string;
    provider: OAuthProvider;
    subValue: string;
    findBySub: (db: D1Database, sub: string) => Promise<User | null>;
    email: string;
    name: string;
    picture: string | null;
    // undefined: プロフィール更新時にemailを更新しない（Google以外）
    profileEmailUpdate: { email: string; emailVerified: boolean } | undefined;
    // undefined: メール連携しない（X）/ {}: email_verifiedを更新しない / { emailVerified }: 更新する（Google）
    emailLink: { emailVerified?: boolean } | undefined;
    newUserEmailVerified: boolean;
  }
): Promise<User> {
  const subColumn = PROVIDER_COLUMN[opts.provider];
  const providerLabel = PROVIDER_DISPLAY_NAMES[opts.provider];
  // 既存ユーザー（同プロバイダー）のプロフィール更新
  const existingBySub = await opts.findBySub(db, opts.subValue);
  if (existingBySub) {
    if (opts.profileEmailUpdate) {
      const user = await db
        .prepare(
          `UPDATE users SET email = ?, email_verified = ?, name = ?, picture = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`
        )
        .bind(
          opts.profileEmailUpdate.email,
          opts.profileEmailUpdate.emailVerified ? 1 : 0,
          opts.name,
          opts.picture,
          existingBySub.id
        )
        .first<User>();
      if (!user) throw new Error(`Failed to update ${providerLabel} user`);
      return user;
    }
    const user = await db
      .prepare(
        `UPDATE users SET name = ?, picture = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`
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
        sql = `UPDATE users SET ${subColumn} = ?, email_verified = ?, name = ?, picture = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`;
        bindings = [opts.subValue, opts.emailLink.emailVerified ? 1 : 0, opts.name, opts.picture, existingByEmail.id];
      } else {
        sql = `UPDATE users SET ${subColumn} = ?, name = ?, picture = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`;
        bindings = [opts.subValue, opts.name, opts.picture, existingByEmail.id];
      }
      const user = await db.prepare(sql).bind(...bindings).first<User>();
      if (!user) throw new Error(`Failed to link ${providerLabel} account`);
      return user;
    }
  }

  // 新規ユーザー作成
  const user = await db
    .prepare(
      `INSERT INTO users (id, ${subColumn}, email, email_verified, name, picture) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .bind(opts.id, opts.subValue, opts.email, opts.newUserEmailVerified ? 1 : 0, opts.name, opts.picture)
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
  }
): Promise<User> {
  return upsertProviderUser(db, {
    id: params.id,
    provider: 'google',
    subValue: params.googleSub,
    findBySub: findUserByGoogleSub,
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
  }
): Promise<User> {
  return upsertProviderUser(db, {
    id: params.id,
    provider: 'line',
    subValue: params.lineSub,
    findBySub: findUserByLineSub,
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
  }
): Promise<User> {
  return upsertProviderUser(db, {
    id: params.id,
    provider: 'twitch',
    subValue: params.twitchSub,
    findBySub: findUserByTwitchSub,
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
  }
): Promise<User> {
  return upsertProviderUser(db, {
    id: params.id,
    provider: 'github',
    subValue: params.githubSub,
    findBySub: findUserByGithubSub,
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
    name: string;
    picture: string | null;
  }
): Promise<User> {
  return upsertProviderUser(db, {
    id: params.id,
    provider: 'x',
    subValue: params.xSub,
    findBySub: findUserByXSub,
    email: params.email,
    name: params.name,
    picture: params.picture,
    profileEmailUpdate: undefined,
    emailLink: undefined,
    newUserEmailVerified: false,
  });
}

export async function updateUserRole(
  db: D1Database,
  userId: string,
  role: 'user' | 'admin'
): Promise<User> {
  const user = await db
    .prepare(`UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`)
    .bind(role, userId)
    .first<User>();
  if (!user) throw new Error('User not found');
  return user;
}

export async function deleteUser(db: D1Database, userId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  return (result.meta.changes ?? 0) > 0;
}



export async function updateUserProfile(
  db: D1Database,
  userId: string,
  params: { name: string; picture?: string | null; phone?: string | null; address?: string | null }
): Promise<User> {
  const setClauses: string[] = ['name = ?'];
  const values: unknown[] = [params.name];

  if ('picture' in params) {
    setClauses.push('picture = ?');
    values.push(params.picture ?? null);
  }
  if ('phone' in params) {
    setClauses.push('phone = ?');
    values.push(params.phone ?? null);
  }
  if ('address' in params) {
    setClauses.push('address = ?');
    values.push(params.address ?? null);
  }
  setClauses.push("updated_at = datetime('now')");
  values.push(userId);

  const user = await db
    .prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ? RETURNING *`)
    .bind(...values)
    .first<User>();
  if (!user) throw new Error('User not found');
  return user;
}

export async function countAdminUsers(db: D1Database): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM users WHERE role = ?')
    .bind('admin')
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export interface UserFilter {
  email?: string;
  role?: 'user' | 'admin';
  name?: string;
  /** true: BAN済みのみ / false: BAN済み除外 / undefined: 全件 */
  banned?: boolean;
}

function buildUserFilterClause(filter?: UserFilter): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.email) {
    conditions.push('email LIKE ?');
    params.push(`%${filter.email}%`);
  }
  if (filter?.role) {
    conditions.push('role = ?');
    params.push(filter.role);
  }
  if (filter?.name) {
    conditions.push('name LIKE ?');
    params.push(`%${filter.name}%`);
  }
  if (filter?.banned === true) {
    conditions.push('banned_at IS NOT NULL');
  } else if (filter?.banned === false) {
    conditions.push('banned_at IS NULL');
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export async function listUsers(
  db: D1Database,
  limit: number = 50,
  offset: number = 0,
  filter?: UserFilter
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
  if (!user) throw new Error('User not found');
  const providers = ALL_PROVIDERS;
  return providers.map((p) => ({
    provider: p,
    connected: user[PROVIDER_COLUMN[p] as keyof User] !== null,
  }));
}

export async function unlinkProvider(
  db: D1Database,
  userId: string,
  provider: OAuthProvider
): Promise<void> {
  const col = PROVIDER_COLUMN[provider];
  const result = await db
    .prepare(`UPDATE users SET ${col} = NULL, updated_at = datetime('now') WHERE id = ?`)
    .bind(userId)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new Error('User not found');
}

export async function banUser(db: D1Database, userId: string): Promise<User> {
  const user = await db
    .prepare(`UPDATE users SET banned_at = datetime('now'), updated_at = datetime('now') WHERE id = ? RETURNING *`)
    .bind(userId)
    .first<User>();
  if (!user) throw new Error('User not found');
  return user;
}

export async function unbanUser(db: D1Database, userId: string): Promise<User> {
  const user = await db
    .prepare(`UPDATE users SET banned_at = NULL, updated_at = datetime('now') WHERE id = ? RETURNING *`)
    .bind(userId)
    .first<User>();
  if (!user) throw new Error('User not found');
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
  days: number = 30
): Promise<DailyUserRegistrationStat[]> {
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = await db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at) as date, COUNT(*) as count
       FROM users
       WHERE created_at >= ?
       GROUP BY date
       ORDER BY date ASC`
    )
    .bind(sinceIso)
    .all<DailyUserRegistrationStat>();
  return result.results;
}

export async function linkProvider(
  db: D1Database,
  userId: string,
  provider: OAuthProvider,
  sub: string
): Promise<User> {
  // 他ユーザーが同サブIDを使用中か確認
  const findBySubFns: Record<
    OAuthProvider,
    (db: D1Database, sub: string) => Promise<User | null>
  > = {
    google: findUserByGoogleSub,
    line: findUserByLineSub,
    twitch: findUserByTwitchSub,
    github: findUserByGithubSub,
    x: findUserByXSub,
  };
  const existing = await findBySubFns[provider](db, sub);
  if (existing && existing.id !== userId) {
    throw new Error('PROVIDER_ALREADY_LINKED');
  }

  const col = PROVIDER_COLUMN[provider];
  const user = await db
    .prepare(
      `UPDATE users SET ${col} = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`
    )
    .bind(sub, userId)
    .first<User>();
  if (!user) throw new Error('User not found');
  return user;
}
