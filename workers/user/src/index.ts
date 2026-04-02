import { Hono } from 'hono';

import type { BffEnv } from '@0g0-id/shared';
import { logger, securityHeaders, bodyLimitMiddleware, bffCorsMiddleware, bffCsrfMiddleware, createLogger } from '@0g0-id/shared';
import authRoutes from './routes/auth';
import profileRoutes from './routes/profile';
import connectionsRoutes from './routes/connections';
import providersRoutes from './routes/providers';
import loginHistoryRoutes from './routes/login-history';
import sessionsRoutes from './routes/sessions';
import securityRoutes from './routes/security';

const appLogger = createLogger('user');

const app = new Hono<{ Bindings: BffEnv }>();

app.use('*', logger());
app.use('*', securityHeaders());
app.use('*', bodyLimitMiddleware());

// ユーザー画面APIへのCORSをユーザー画面自身のドメインのみに制限
app.use('/api/*', bffCorsMiddleware);

// 外部サービスからのAPIアクセスを禁止（Originヘッダー検証）
// /api/* および /auth/logout に適用（強制ログアウトCSRF対策）
app.use('/api/*', bffCsrfMiddleware);
app.use('/auth/logout', bffCsrfMiddleware);
app.use('/auth/link', bffCsrfMiddleware);

app.route('/auth', authRoutes);
app.route('/api/me', profileRoutes);
app.route('/api/connections', connectionsRoutes);
app.route('/api/providers', providersRoutes);
app.route('/api/login-history', loginHistoryRoutes);
app.route('/api/me/sessions', sessionsRoutes);
app.route('/api/me/security', securityRoutes);

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', worker: 'user', timestamp: new Date().toISOString() });
});

app.onError((err, c) => {
  appLogger.error('Unhandled error', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

export default app;
