import { Hono } from 'hono';
import type { BffEnv } from '@0g0-id/shared';
import { logger } from '@0g0-id/shared';
import authRoutes from './routes/auth';
import { userCorsMiddleware } from './middleware/cors';
import { userCsrfMiddleware } from './middleware/csrf';
import profileRoutes from './routes/profile';
import connectionsRoutes from './routes/connections';
import providersRoutes from './routes/providers';
import loginHistoryRoutes from './routes/login-history';
import sessionsRoutes from './routes/sessions';

const app = new Hono<{ Bindings: BffEnv }>();

app.use('*', logger());

// ユーザー画面APIへのCORSをユーザー画面自身のドメインのみに制限
app.use('/api/*', userCorsMiddleware);

// 外部サービスからのAPIアクセスを禁止（Originヘッダー検証）
// /api/* および /auth/logout に適用（強制ログアウトCSRF対策）
app.use('/api/*', userCsrfMiddleware);
app.use('/auth/logout', userCsrfMiddleware);

app.route('/auth', authRoutes);
app.route('/api/me', profileRoutes);
app.route('/api/connections', connectionsRoutes);
app.route('/api/providers', providersRoutes);
app.route('/api/login-history', loginHistoryRoutes);
app.route('/api/me/sessions', sessionsRoutes);

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', worker: 'user', timestamp: new Date().toISOString() });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

export default app;
