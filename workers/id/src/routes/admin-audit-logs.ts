import { Hono } from 'hono';
import { listAdminAuditLogs, getAuditLogStats, parsePagination } from '@0g0-id/shared';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';

type Variables = { user: TokenPayload };

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/admin/audit-logs/stats — 監査ログ統計（管理者のみ）
app.get('/stats', authMiddleware, adminMiddleware, async (c) => {
  const daysStr = c.req.query('days');
  const parsed = daysStr !== undefined ? parseInt(daysStr, 10) : NaN;
  const days = Math.min(Math.max(Number.isNaN(parsed) ? 30 : parsed, 1), 90);

  const stats = await getAuditLogStats(c.env.DB, days);
  return c.json({ data: stats, days });
});

// GET /api/admin/audit-logs — 管理者操作の監査ログ一覧（管理者のみ）
app.get('/', authMiddleware, adminMiddleware, async (c) => {
  const pagination = parsePagination(
    { limit: c.req.query('limit'), offset: c.req.query('offset') },
    { defaultLimit: 50, maxLimit: 100 }
  );
  if ('error' in pagination) {
    return c.json({ error: { code: 'BAD_REQUEST', message: pagination.error } }, 400);
  }
  const { limit, offset } = pagination;

  const adminUserId = c.req.query('admin_user_id');
  const targetId = c.req.query('target_id');
  const action = c.req.query('action');

  const { logs, total } = await listAdminAuditLogs(c.env.DB, limit, offset, {
    adminUserId,
    targetId,
    action,
  });

  return c.json({
    data: logs,
    pagination: { total, limit, offset },
  });
});

export default app;
