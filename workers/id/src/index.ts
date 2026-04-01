import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { logger, securityHeaders, createLogger } from '@0g0-id/shared';
import { validateEnv } from './utils/env-validation';
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

// 環境変数バリデーション（設定ミスを早期検知）
app.use('*', async (c, next) => {
  const validation = validateEnv(c.env);
  if (!validation.ok) {
    appLogger.error('環境変数バリデーションエラー', { errors: validation.errors });
    return c.json(
      { error: { code: 'MISCONFIGURATION', message: 'Server misconfiguration' } },
      500,
    );
  }
  await next();
});

app.use('*', logger());
app.use('*', securityHeaders());

// リクエストボディサイズ制限（メモリ消耗攻撃防止）
// IdPの全エンドポイントは小さなJSONボディのみ受け付けるため64KBで十分
app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => {
  return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } }, 413);
}}));

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
