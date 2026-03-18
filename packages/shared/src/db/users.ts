import type { User } from '../types';

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

export async function findUserByEmail(db: D1Database, email: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
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
  const user = await db
    .prepare(
      `INSERT INTO users (id, google_sub, email, email_verified, name, picture)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(google_sub) DO UPDATE SET
         email = excluded.email,
         email_verified = excluded.email_verified,
         name = excluded.name,
         picture = excluded.picture,
         updated_at = datetime('now')
       RETURNING *`
    )
    .bind(
      params.id,
      params.googleSub,
      params.email,
      params.emailVerified ? 1 : 0,
      params.name,
      params.picture
    )
    .first<User>();
  if (!user) throw new Error('Failed to upsert user');
  return user;
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
  // 既存のLINEユーザーがいればプロフィールを更新
  const existing = await findUserByLineSub(db, params.lineSub);
  if (existing) {
    const user = await db
      .prepare(
        `UPDATE users SET name = ?, picture = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`
      )
      .bind(params.name, params.picture, existing.id)
      .first<User>();
    if (!user) throw new Error('Failed to update LINE user');
    return user;
  }

  // 仮メール以外であれば既存ユーザーにLINEアカウントを連携
  if (!params.isPlaceholderEmail) {
    const existingByEmail = await findUserByEmail(db, params.email);
    if (existingByEmail) {
      const user = await db
        .prepare(
          `UPDATE users SET line_sub = ?, name = ?, picture = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`
        )
        .bind(params.lineSub, params.name, params.picture, existingByEmail.id)
        .first<User>();
      if (!user) throw new Error('Failed to link LINE account');
      return user;
    }
  }

  // 新規ユーザー作成（仮メールはemail_verified=0）
  const user = await db
    .prepare(
      `INSERT INTO users (id, line_sub, email, email_verified, name, picture)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      params.id,
      params.lineSub,
      params.email,
      params.isPlaceholderEmail ? 0 : 1,
      params.name,
      params.picture
    )
    .first<User>();
  if (!user) throw new Error('Failed to create LINE user');
  return user;
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
  // 既存のTwitchユーザーがいればプロフィールを更新
  const existing = await findUserByTwitchSub(db, params.twitchSub);
  if (existing) {
    const user = await db
      .prepare(
        `UPDATE users SET name = ?, picture = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`
      )
      .bind(params.name, params.picture, existing.id)
      .first<User>();
    if (!user) throw new Error('Failed to update Twitch user');
    return user;
  }

  // 仮メール以外であれば既存ユーザーにTwitchアカウントを連携
  if (!params.isPlaceholderEmail) {
    const existingByEmail = await findUserByEmail(db, params.email);
    if (existingByEmail) {
      const user = await db
        .prepare(
          `UPDATE users SET twitch_sub = ?, name = ?, picture = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`
        )
        .bind(params.twitchSub, params.name, params.picture, existingByEmail.id)
        .first<User>();
      if (!user) throw new Error('Failed to link Twitch account');
      return user;
    }
  }

  // 新規ユーザー作成
  const user = await db
    .prepare(
      `INSERT INTO users (id, twitch_sub, email, email_verified, name, picture)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      params.id,
      params.twitchSub,
      params.email,
      params.isPlaceholderEmail ? 0 : params.emailVerified ? 1 : 0,
      params.name,
      params.picture
    )
    .first<User>();
  if (!user) throw new Error('Failed to create Twitch user');
  return user;
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

export async function updateUserName(db: D1Database, userId: string, name: string): Promise<User> {
  const user = await db
    .prepare(`UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`)
    .bind(name, userId)
    .first<User>();
  if (!user) throw new Error('User not found');
  return user;
}

export async function updateUserProfile(
  db: D1Database,
  userId: string,
  params: { name: string; phone?: string | null; address?: string | null }
): Promise<User> {
  const setClauses: string[] = ['name = ?', "updated_at = datetime('now')"];
  const values: unknown[] = [params.name];

  if ('phone' in params) {
    setClauses.splice(1, 0, 'phone = ?');
    values.push(params.phone ?? null);
  }
  if ('address' in params) {
    setClauses.splice('phone' in params ? 2 : 1, 0, 'address = ?');
    values.push(params.address ?? null);
  }
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

export async function listUsers(
  db: D1Database,
  limit: number = 50,
  offset: number = 0
): Promise<User[]> {
  const result = await db
    .prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .bind(limit, offset)
    .all<User>();
  return result.results;
}

export async function countUsers(db: D1Database): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM users')
    .first<{ count: number }>();
  return result?.count ?? 0;
}
