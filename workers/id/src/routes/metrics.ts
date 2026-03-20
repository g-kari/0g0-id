import { Hono } from 'hono';
import {
  countUsers,
  countAdminUsers,
  countServices,
  countActiveRefreshTokens,
  countRecentLoginEvents,
} from '@0g0-id/shared';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';

type Variables = { user: TokenPayload };

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/metrics
app.get('/', authMiddleware, adminMiddleware, async (c) => {
  const recentSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [totalUsers, adminUsers, totalServices, activeTokens, recentLogins] = await Promise.all([
    countUsers(c.env.DB),
    countAdminUsers(c.env.DB),
    countServices(c.env.DB),
    countActiveRefreshTokens(c.env.DB),
    countRecentLoginEvents(c.env.DB, recentSince),
  ]);

  return c.json({
    data: {
      total_users: totalUsers,
      admin_users: adminUsers,
      total_services: totalServices,
      active_sessions: activeTokens,
      recent_logins_24h: recentLogins,
    },
  });
});

export default app;
