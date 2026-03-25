import { Hono } from 'hono';
import {
  countUsers,
  countAdminUsers,
  countServices,
  countActiveRefreshTokens,
  countRecentLoginEvents,
  getLoginEventProviderStats,
  getDailyLoginTrends,
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

  const [totalUsers, adminUsers, bannedUsers, totalServices, activeTokens, recentLogins24h, recentLogins7d, providerStats7d] =
    await Promise.all([
      countUsers(c.env.DB),
      countAdminUsers(c.env.DB),
      countUsers(c.env.DB, { banned: true }),
      countServices(c.env.DB),
      countActiveRefreshTokens(c.env.DB),
      countRecentLoginEvents(c.env.DB, since24h),
      countRecentLoginEvents(c.env.DB, since7d),
      getLoginEventProviderStats(c.env.DB, since7d),
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
    },
    });
});

// GET /api/metrics/login-trends?days=30
app.get('/login-trends', authMiddleware, adminMiddleware, async (c) => {
  const daysStr = c.req.query('days');
  const parsed = daysStr !== undefined ? parseInt(daysStr, 10) : NaN;
  const days = Math.min(Math.max(Number.isNaN(parsed) ? 30 : parsed, 1), 90);

  const trends = await getDailyLoginTrends(c.env.DB, days);

  return c.json({ data: trends, days });
});


export default app;
