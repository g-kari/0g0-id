import type { User } from '../types';

export async function findUserById(db: D1Database, id: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
}

export async function findUserByGoogleSub(db: D1Database, googleSub: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(googleSub).first<User>();
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

export async function updateUserRole(
  db: D1Database,
  userId: string,
  role: 'user' | 'admin'
): Promise<void> {
  await db
    .prepare(`UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(role, userId)
    .run();
}

export async function updateUserName(db: D1Database, userId: string, name: string): Promise<void> {
  await db
    .prepare(`UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(name, userId)
    .run();
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
