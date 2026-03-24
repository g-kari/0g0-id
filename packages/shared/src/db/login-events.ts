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
  offset = 0,
  provider?: string
): Promise<{ events: LoginEvent[]; total: number }> {
  const providerClause = provider ? ' AND provider = ?' : '';
  const [eventsResult, countResult] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM login_events WHERE user_id = ?${providerClause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .bind(...(provider ? [userId, provider, limit, offset] : [userId, limit, offset]))
      .all<LoginEvent>(),
    db
      .prepare(`SELECT COUNT(*) as count FROM login_events WHERE user_id = ?${providerClause}`)
      .bind(...(provider ? [userId, provider] : [userId]))
      .first<{ count: number }>(),
  ]);
  return {
    events: eventsResult.results,
    total: countResult?.count ?? 0,
  };
}

export async function countRecentLoginEvents(
  db: D1Database,
  sinceIso: string
): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM login_events WHERE created_at >= ?')
    .bind(sinceIso)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

/** プロバイダー別ログイン回数の統計エントリ */
export interface LoginProviderStat {
  provider: string;
  count: number;
}

/**
 * 指定期間内のプロバイダー別ログイン統計を返す。
 * ログインが0件のプロバイダーは結果に含まれない。
 * count の降順でソートされる。
 */
export async function getLoginEventProviderStats(
  db: D1Database,
  sinceIso: string
): Promise<LoginProviderStat[]> {
  const result = await db
    .prepare(
      `SELECT provider, COUNT(*) as count
       FROM login_events
       WHERE created_at >= ?
       GROUP BY provider
       ORDER BY count DESC`
    )
    .bind(sinceIso)
    .all<LoginProviderStat>();
  return result.results;
}

export async function getUserLoginProviderStats(
  db: D1Database,
  userId: string,
  sinceIso: string
): Promise<LoginProviderStat[]> {
  const result = await db
    .prepare(
      `SELECT provider, COUNT(*) as count
       FROM login_events
       WHERE user_id = ? AND created_at >= ?
       GROUP BY provider
       ORDER BY count DESC`
    )
    .bind(userId, sinceIso)
    .all<LoginProviderStat>();
  return result.results;
}
