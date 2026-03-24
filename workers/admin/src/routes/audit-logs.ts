import { Hono } from 'hono';
import { fetchWithAuth, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/audit-logs — 管理者操作の監査ログ一覧（IdPへプロキシ）
app.get('/', async (c) => {
  const url = new URL(`${c.env.IDP_ORIGIN}/api/admin/audit-logs`);
  url.searchParams.set('limit', c.req.query('limit') ?? '50');
  url.searchParams.set('offset', c.req.query('offset') ?? '0');
  const adminUserId = c.req.query('admin_user_id');
  const targetId = c.req.query('target_id');
  const action = c.req.query('action');
  if (adminUserId) url.searchParams.set('admin_user_id', adminUserId);
  if (targetId) url.searchParams.set('target_id', targetId);
  if (action) url.searchParams.set('action', action);

  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

export default app;
