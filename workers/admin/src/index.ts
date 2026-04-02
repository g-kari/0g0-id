import { Hono } from 'hono';

import { getCookie, deleteCookie } from 'hono/cookie';
import type { BffEnv } from '@0g0-id/shared';
import { logger, securityHeaders, bodyLimitMiddleware, bffCorsMiddleware, bffCsrfMiddleware, createLogger, parseSession } from '@0g0-id/shared';
import authRoutes from './routes/auth';
import { SESSION_COOKIE } from './routes/auth';
import servicesRoutes from './routes/services';
import usersRoutes from './routes/users';
import metricsRoutes from './routes/metrics';
import auditLogsRoutes from './routes/audit-logs';

const appLogger = createLogger('admin');

const app = new Hono<{ Bindings: BffEnv }>();

app.use('*', logger());
app.use('*', securityHeaders());
app.use('*', bodyLimitMiddleware());

// 管理画面APIへのCORSを管理画面自身のドメインのみに制限
app.use('/api/*', bffCorsMiddleware);

// 外部サービスからのAPIアクセスを禁止（Originヘッダー検証）
// /api/* および /auth/logout に適用（強制ログアウトCSRF対策）
app.use('/api/*', bffCsrfMiddleware);
app.use('/auth/logout', bffCsrfMiddleware);

// 管理者ロール検証ミドルウェア（多層防御）
// IdP側でroleがadminから降格されたセッションを早期拒否する
app.use('/api/*', async (c, next) => {
  const cookie = getCookie(c, SESSION_COOKIE);
  const session = await parseSession(cookie, c.env.SESSION_SECRET);
  if (!session) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
  }
  if (session.user.role !== 'admin') {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    return c.json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
  }
  await next();
});

app.route('/auth', authRoutes);
app.route('/api/services', servicesRoutes);
app.route('/api/users', usersRoutes);
app.route('/api/metrics', metricsRoutes);
app.route('/api/audit-logs', auditLogsRoutes);

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', worker: 'admin', timestamp: new Date().toISOString() });
});

app.onError((err, c) => {
  appLogger.error('Unhandled error', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

export default app;
