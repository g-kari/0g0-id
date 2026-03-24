import { Hono } from 'hono';
import type { BffEnv } from '@0g0-id/shared';
import { logger, securityHeaders, bffCorsMiddleware, bffCsrfMiddleware } from '@0g0-id/shared';
import authRoutes from './routes/auth';
import servicesRoutes from './routes/services';
import usersRoutes from './routes/users';
import metricsRoutes from './routes/metrics';

const app = new Hono<{ Bindings: BffEnv }>();

app.use('*', logger());
app.use('*', securityHeaders());

// 管理画面APIへのCORSを管理画面自身のドメインのみに制限
app.use('/api/*', bffCorsMiddleware);

// 外部サービスからのAPIアクセスを禁止（Originヘッダー検証）
// /api/* および /auth/logout に適用（強制ログアウトCSRF対策）
app.use('/api/*', bffCsrfMiddleware);
app.use('/auth/logout', bffCsrfMiddleware);

app.route('/auth', authRoutes);
app.route('/api/services', servicesRoutes);
app.route('/api/users', usersRoutes);
app.route('/api/metrics', metricsRoutes);

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', worker: 'admin', timestamp: new Date().toISOString() });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

export default app;
