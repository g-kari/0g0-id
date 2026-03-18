import { Hono } from 'hono';
import {
  countUsers,
  countAdminUsers,
  countServices,
  countActiveRefreshTokens,
} from '@0g0-id/shared';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';

type Variables = { user: TokenPayload };

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/metrics
app.get('/', authMiddleware, adminMiddleware, async (c) => {
  const [totalUsers, adminUsers, totalServices, activeTokens] = await Promise.all([
    countUsers(c.env.DB),
    countAdminUsers(c.env.DB),
    countServices(c.env.DB),
    countActiveRefreshTokens(c.env.DB),
  ]);

  return c.json({
    data: {
      total_users: totalUsers,
      admin_users: adminUsers,
      total_services: totalServices,
      active_sessions: activeTokens,
    },
  });
});

export default app;
