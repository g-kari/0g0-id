import { Hono } from 'hono';
import type { BffEnv } from '@0g0-id/shared';
import { logger } from '@0g0-id/shared';
import authRoutes from './routes/auth';
import servicesRoutes from './routes/services';
import usersRoutes from './routes/users';

const app = new Hono<{ Bindings: BffEnv }>();

app.use('*', logger());

app.route('/auth', authRoutes);
app.route('/api/services', servicesRoutes);
app.route('/api/users', usersRoutes);

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', worker: 'admin', timestamp: new Date().toISOString() });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

export default app;
