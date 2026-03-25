import { Hono } from 'hono';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { logger, securityHeaders, createLogger } from '@0g0-id/shared';
import authRoutes from './routes/auth';
import usersRoutes from './routes/users';
import tokenRoutes from './routes/token';
import servicesRoutes from './routes/services';
import metricsRoutes from './routes/metrics';
import wellKnownRoutes from './routes/well-known';
import docsRoutes from './routes/docs';
import adminAuditLogsRoutes from './routes/admin-audit-logs';
import externalRoutes from './routes/external';
import userInfoRoutes from './routes/userinfo';

const appLogger = createLogger('id');

type Variables = { user: TokenPayload };

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

app.use('*', logger());
app.use('*', securityHeaders());

// ルート登録
app.route('/auth', authRoutes);
app.route('/.well-known', wellKnownRoutes);
app.route('/api/users', usersRoutes);
app.route('/api/token', tokenRoutes);
app.route('/api/services', servicesRoutes);
app.route('/api/metrics', metricsRoutes);
app.route('/api/external', externalRoutes);
app.route('/api/userinfo', userInfoRoutes);
app.route('/docs', docsRoutes);
app.route('/api/admin/audit-logs', adminAuditLogsRoutes);

// ヘルスチェック
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', worker: 'id', timestamp: new Date().toISOString() });
});

// エラーハンドリング
app.onError((err, c) => {
  appLogger.error('Unhandled error', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

app.notFound((c) => {
  return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
});

export default app;
