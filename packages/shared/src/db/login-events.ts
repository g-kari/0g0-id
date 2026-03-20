import type { LoginEvent } from '../types';

export async function insertLoginEvent(
  db: D1Database,
  data: {
    userId: string;
    provider: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }
): Promise<void> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO login_events (id, user_id, provider, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(id, data.userId, data.provider, data.ipAddress ?? null, data.userAgent ?? null)
    .run();
}

export async function getLoginEventsByUserId(
  db: D1Database,
  userId: string,
  limit = 20,
  offset = 0
): Promise<{ events: LoginEvent[]; total: number }> {
  const [eventsResult, countResult] = await Promise.all([
    db
      .prepare(
        'SELECT * FROM login_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      )
      .bind(userId, limit, offset)
      .all<LoginEvent>(),
    db
      .prepare('SELECT COUNT(*) as count FROM login_events WHERE user_id = ?')
      .bind(userId)
      .first<{ count: number }>(),
  ]);
  return {
    events: eventsResult.results,
    total: countResult?.count ?? 0,
  };
}
