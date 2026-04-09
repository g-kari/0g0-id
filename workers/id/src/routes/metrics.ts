import { Hono } from 'hono';
import {
  countUsers,
  countAdminUsers,
  countServices,
  countActiveRefreshTokens,
  countRecentLoginEvents,
  getLoginEventProviderStats,
  getLoginEventCountryStats,
  getDailyLoginTrends,
  getServiceTokenStats,
  getSuspiciousMultiCountryLogins,
  getDailyUserRegistrations,
  getActiveUserStats,
  getDailyActiveUsers,
  parseDays,
} from '@0g0-id/shared';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';

type Variables = { user: TokenPayload };

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/metrics
app.get('/', authMiddleware, adminMiddleware, async (c) => {
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const [
      totalUsers,
      adminUsers,
      bannedUsers,
      totalServices,
      activeTokens,
      recentLogins24h,
      recentLogins7d,
      providerStats7d,
      countryStats7d,
    ] = await Promise.all([
      countUsers(c.env.DB),
      countAdminUsers(c.env.DB),
      countUsers(c.env.DB, { banned: true }),
      countServices(c.env.DB),
      countActiveRefreshTokens(c.env.DB),
      countRecentLoginEvents(c.env.DB, since24h),
      countRecentLoginEvents(c.env.DB, since7d),
      getLoginEventProviderStats(c.env.DB, since7d),
      getLoginEventCountryStats(c.env.DB, since7d),
    ]);

    return c.json({
      data: {
        total_users: totalUsers,
        admin_users: adminUsers,
        banned_users: bannedUsers,
        total_services: totalServices,
        active_sessions: activeTokens,
        recent_logins_24h: recentLogins24h,
        recent_logins_7d: recentLogins7d,
        login_provider_stats_7d: providerStats7d,
        login_country_stats_7d: countryStats7d,
      },
    });
  } catch {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch metrics' } }, 500);
  }
});

// GET /api/metrics/login-trends?days=30
app.get('/login-trends', authMiddleware, adminMiddleware, async (c) => {
  const daysResult = parseDays(c.req.query('days'), { maxDays: 365 });
  if (daysResult && 'error' in daysResult) {
    return c.json({ error: daysResult.error }, 400);
  }
  const days = daysResult?.days ?? 30;

  const trends = await getDailyLoginTrends(c.env.DB, days);

  return c.json({ data: trends, days });
});

// GET /api/metrics/services — サービス別アクティブトークン統計
app.get('/services', authMiddleware, adminMiddleware, async (c) => {
  const stats = await getServiceTokenStats(c.env.DB);
  return c.json({ data: stats });
});

// GET /api/metrics/suspicious-logins?hours=24&min_countries=2
app.get('/suspicious-logins', authMiddleware, adminMiddleware, async (c) => {
  const hoursStr = c.req.query('hours');
  const parsedHours = hoursStr !== undefined ? parseInt(hoursStr, 10) : NaN;
  const hours = Math.min(Math.max(Number.isNaN(parsedHours) ? 24 : parsedHours, 1), 168); // 1h〜7日

  const minCountriesStr = c.req.query('min_countries');
  const parsedMin = minCountriesStr !== undefined ? parseInt(minCountriesStr, 10) : NaN;
  const minCountries = Math.min(Math.max(Number.isNaN(parsedMin) ? 2 : parsedMin, 2), 10);

  const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const logins = await getSuspiciousMultiCountryLogins(c.env.DB, sinceIso, minCountries);

  return c.json({ data: logins, meta: { hours, min_countries: minCountries } });
});

// GET /api/metrics/user-registrations?days=30 — 日別新規ユーザー登録数
app.get('/user-registrations', authMiddleware, adminMiddleware, async (c) => {
  const daysResult = parseDays(c.req.query('days'), { maxDays: 365 });
  if (daysResult && 'error' in daysResult) {
    return c.json({ error: daysResult.error }, 400);
  }
  const days = daysResult?.days ?? 30;

  const registrations = await getDailyUserRegistrations(c.env.DB, days);

  return c.json({ data: registrations, days });
});

// GET /api/metrics/active-users - DAU/WAU/MAU アクティブユーザー数
app.get('/active-users', authMiddleware, adminMiddleware, async (c) => {
  const stats = await getActiveUserStats(c.env.DB);
  return c.json({ data: stats });
});

// GET /api/metrics/active-users/daily?days=30 - 日別アクティブユーザー数推移
app.get('/active-users/daily', authMiddleware, adminMiddleware, async (c) => {
  const daysResult = parseDays(c.req.query('days'));
  if (daysResult && 'error' in daysResult) {
    return c.json({ error: daysResult.error }, 400);
  }
  const days = daysResult?.days ?? 30;
  const data = await getDailyActiveUsers(c.env.DB, days);
  return c.json({ data, days });
});

export default app;
