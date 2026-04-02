import { Hono } from 'hono';
import { fetchWithAuth, parsePagination, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/audit-logs — 管理者操作の監査ログ一覧（IdPへプロキシ）
app.get('/', async (c) => {
  const pagination = parsePagination(
    { limit: c.req.query('limit'), offset: c.req.query('offset') },
    { defaultLimit: 50, maxLimit: 100 }
  );
  if ('error' in pagination) {
    return c.json({ error: { code: 'BAD_REQUEST', message: pagination.error } }, 400);
  }
  const url = new URL(`${c.env.IDP_ORIGIN}/api/admin/audit-logs`);
  url.searchParams.set('limit', String(pagination.limit));
  url.searchParams.set('offset', String(pagination.offset));
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const adminUserId = c.req.query('admin_user_id');
  const targetId = c.req.query('target_id');
  const action = c.req.query('action');
  if (adminUserId) {
    if (!UUID_RE.test(adminUserId)) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid admin_user_id format' } }, 400);
    }
    url.searchParams.set('admin_user_id', adminUserId);
  }
  if (targetId) {
    if (!UUID_RE.test(targetId)) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid target_id format' } }, 400);
    }
    url.searchParams.set('target_id', targetId);
  }
  if (action) {
    if (!/^[a-z]+\.[a-z_]+$/.test(action)) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid action format' } }, 400);
    }
    url.searchParams.set('action', action);
  }

  const res = await fetchWithAuth(c, SESSION_COOKIE, url.toString());
  return proxyResponse(res);
});

export default app;
