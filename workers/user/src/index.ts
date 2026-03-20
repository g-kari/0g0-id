import { Hono } from 'hono';
import type { BffEnv } from '@0g0-id/shared';
import { logger } from '@0g0-id/shared';
import authRoutes from './routes/auth';
import profileRoutes from './routes/profile';
import connectionsRoutes from './routes/connections';
import providersRoutes from './routes/providers';
import loginHistoryRoutes from './routes/login-history';

const app = new Hono<{ Bindings: BffEnv }>();

app.use('*', logger());

app.route('/auth', authRoutes);
app.route('/api/me', profileRoutes);
app.route('/api/connections', connectionsRoutes);
app.route('/api/providers', providersRoutes);
app.route('/api/login-history', loginHistoryRoutes);

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', worker: 'user', timestamp: new Date().toISOString() });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

export default app;
