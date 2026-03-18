import { Hono } from 'hono';
import { findUserById, listUsers, updateUserName } from '@0g0-id/shared';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import { csrfMiddleware } from '../middleware/csrf';

type Variables = { user: TokenPayload };

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/users/me
app.get('/me', authMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const user = await findUserById(c.env.DB, tokenUser.sub);
  if (!user) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }
  return c.json({
    data: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      role: user.role,
    },
  });
});

// PATCH /api/users/me
app.patch('/me', authMiddleware, csrfMiddleware, async (c) => {
  const tokenUser = c.get('user');

  let body: { name?: string };
  try {
    body = await c.req.json<{ name?: string }>();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'name is required' } }, 400);
  }

  await updateUserName(c.env.DB, tokenUser.sub, body.name.trim());
  const user = await findUserById(c.env.DB, tokenUser.sub);

  return c.json({
    data: {
      id: user!.id,
      email: user!.email,
      name: user!.name,
      picture: user!.picture,
      role: user!.role,
    },
  });
});

// GET /api/users（管理者のみ）
app.get('/', authMiddleware, adminMiddleware, async (c) => {
  const limitStr = c.req.query('limit') ?? '50';
  const offsetStr = c.req.query('offset') ?? '0';
  const limit = Math.min(parseInt(limitStr, 10) || 50, 100);
  const offset = parseInt(offsetStr, 10) || 0;

  const users = await listUsers(c.env.DB, limit, offset);
  return c.json({
    data: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      picture: u.picture,
      role: u.role,
      created_at: u.created_at,
    })),
  });
});

export default app;
