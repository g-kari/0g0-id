import type { LoginEvent } from '../types';

export async function insertLoginEvent(
  db: D1Database,
  data: {
    userId: string;
    provider: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    country?: string | null;
  }
): Promise<void> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO login_events (id, user_id, provider, ip_address, user_agent, country) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(id, data.userId, data.provider, data.ipAddress ?? null, data.userAgent ?? null, data.country ?? null)
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

/** 日別ログイン件数の統計エントリ */
export interface DailyLoginStat {
  date: string; // YYYY-MM-DD
  count: number;
}

/**
 * 指定日数分の日別ログイン件数を日付昇順で返す。
 * ログインが0件の日は結果に含まれない。
 */
export async function getDailyLoginTrends(
  db: D1Database,
  days: number = 30
): Promise<DailyLoginStat[]> {
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = await db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at) as date, COUNT(*) as count
       FROM login_events
       WHERE created_at >= ?
       GROUP BY date
       ORDER BY date ASC`
    )
    .bind(sinceIso)
    .all<DailyLoginStat>();
  return result.results;
}

/**
 * 指定ユーザーの指定日数分の日別ログイン件数を日付昇順で返す。
 * ログインが0件の日は結果に含まれない。
 */
export async function getUserDailyLoginTrends(
  db: D1Database,
  userId: string,
  days: number = 30
): Promise<DailyLoginStat[]> {
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = await db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at) as date, COUNT(*) as count
       FROM login_events
       WHERE user_id = ? AND created_at >= ?
       GROUP BY date
       ORDER BY date ASC`
    )
    .bind(userId, sinceIso)
    .all<DailyLoginStat>();
  return result.results;
}

/** 国別ログイン回数の統計エントリ */
export interface LoginCountryStat {
  country: string; // ISO 3166-1 alpha-2（nullの場合は "unknown"）
  count: number;
}

/**
 * 指定期間内の国別ログイン統計を返す。
 * country が NULL のイベントは "unknown" として集計される。
 * count の降順でソートされる。
 */
export async function getLoginEventCountryStats(
  db: D1Database,
  sinceIso: string
): Promise<LoginCountryStat[]> {
  const result = await db
    .prepare(
      `SELECT COALESCE(country, 'unknown') as country, COUNT(*) as count
       FROM login_events
       WHERE created_at >= ?
       GROUP BY country
       ORDER BY count DESC`
    )
    .bind(sinceIso)
    .all<LoginCountryStat>();
  return result.results;
}

/** 複数国からの不審なログイン検知エントリ */
export interface SuspiciousMultiCountryLogin {
  user_id: string;
  country_count: number;
  countries: string; // GROUP_CONCAT によるカンマ区切り国コード
}

/**
 * 指定期間内に複数の異なる国からログインしたユーザーを返す（不審ログイン検知）。
 * minCountries 以上の異なる国からログインしたユーザーのみ返す。
 * country が NULL のイベントは "unknown" として集計される。
 * country_count の降順でソートされる。
 */
export async function getSuspiciousMultiCountryLogins(
  db: D1Database,
  sinceIso: string,
  minCountries: number = 2
): Promise<SuspiciousMultiCountryLogin[]> {
  const result = await db
    .prepare(
      `SELECT
        user_id,
        COUNT(DISTINCT COALESCE(country, 'unknown')) as country_count,
        GROUP_CONCAT(DISTINCT COALESCE(country, 'unknown')) as countries
       FROM login_events
       WHERE created_at >= ?
       GROUP BY user_id
       HAVING country_count >= ?
       ORDER BY country_count DESC`
    )
    .bind(sinceIso, minCountries)
    .all<SuspiciousMultiCountryLogin>();
  return result.results;
}

/** アクティブユーザー数の統計 */
export interface ActiveUserStats {
  dau: number; // 日次アクティブユーザー数（24時間以内にログインしたユニークユーザー）
  wau: number; // 週次アクティブユーザー数（7日以内にログインしたユニークユーザー）
  mau: number; // 月次アクティブユーザー数（30日以内にログインしたユニークユーザー）
}

/**
 * DAU/WAU/MAU（アクティブユーザー数）を並列で取得する。
 * ログインイベントテーブルのユニークuser_idを期間別に集計する。
 */
export async function getActiveUserStats(
  db: D1Database
): Promise<ActiveUserStats> {
  const now = Date.now();
  const dauSince = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
  const wauSince = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const mauSince = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [dauResult, wauResult, mauResult] = await Promise.all([
    db
      .prepare('SELECT COUNT(DISTINCT user_id) as count FROM login_events WHERE created_at >= ?')
      .bind(dauSince)
      .first<{ count: number }>(),
    db
      .prepare('SELECT COUNT(DISTINCT user_id) as count FROM login_events WHERE created_at >= ?')
      .bind(wauSince)
      .first<{ count: number }>(),
    db
      .prepare('SELECT COUNT(DISTINCT user_id) as count FROM login_events WHERE created_at >= ?')
      .bind(mauSince)
      .first<{ count: number }>(),
  ]);

  return {
    dau: dauResult?.count ?? 0,
    wau: wauResult?.count ?? 0,
    mau: mauResult?.count ?? 0,
  };
}

/** 日別アクティブユーザー数の統計エントリ */
export interface DailyActiveUserStat {
  date: string; // YYYY-MM-DD
  count: number; // その日にログインしたユニークユーザー数
}

/**
 * 指定日数分の日別アクティブユーザー数（ユニークユーザー）を日付昇順で返す。
 * ログインが0件の日は結果に含まれない。
 */
export async function getDailyActiveUsers(
  db: D1Database,
  days: number = 30
): Promise<DailyActiveUserStat[]> {
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = await db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at) as date, COUNT(DISTINCT user_id) as count
       FROM login_events
       WHERE created_at >= ?
       GROUP BY date
       ORDER BY date ASC`
    )
    .bind(sinceIso)
    .all<DailyActiveUserStat>();
  return result.results;
}
