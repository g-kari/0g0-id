import { Hono } from 'hono';
import {
  findUserById,
  listUsers,
  countUsers,
  updateUserProfile,
  listUserConnections,
  revokeUserServiceTokens,
} from '@0g0-id/shared';
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
      phone: user.phone,
      address: user.address,
      role: user.role,
    },
  });
});

// PATCH /api/users/me
app.patch('/me', authMiddleware, csrfMiddleware, async (c) => {
  const tokenUser = c.get('user');

  let body: { name?: string; phone?: string | null; address?: string | null };
  try {
    body = await c.req.json<{ name?: string; phone?: string | null; address?: string | null }>();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'name is required' } }, 400);
  }

  if (body.phone !== undefined && body.phone !== null && typeof body.phone !== 'string') {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'phone must be a string or null' } }, 400);
  }

  if (body.address !== undefined && body.address !== null && typeof body.address !== 'string') {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'address must be a string or null' } }, 400);
  }

  const profileUpdate: { name: string; phone?: string | null; address?: string | null } = {
    name: body.name.trim(),
  };
  if ('phone' in body) profileUpdate.phone = body.phone ? body.phone.trim() || null : null;
  if ('address' in body) profileUpdate.address = body.address ? body.address.trim() || null : null;

  let user: Awaited<ReturnType<typeof findUserById>>;
  try {
    user = await updateUserProfile(c.env.DB, tokenUser.sub, profileUpdate);
  } catch {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  return c.json({
    data: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      phone: user.phone,
      address: user.address,
      role: user.role,
    },
  });
});

// GET /api/users/me/connections
app.get('/me/connections', authMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const connections = await listUserConnections(c.env.DB, tokenUser.sub);
  return c.json({ data: connections });
});

// DELETE /api/users/me/connections/:serviceId
app.delete('/me/connections/:serviceId', authMiddleware, csrfMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const serviceId = c.req.param('serviceId');
  const revoked = await revokeUserServiceTokens(c.env.DB, tokenUser.sub, serviceId);
  if (revoked === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Connection not found' } }, 404);
  }
  return c.body(null, 204);
});

// GET /api/users（管理者のみ）
app.get('/', authMiddleware, adminMiddleware, async (c) => {
  const limitStr = c.req.query('limit') ?? '50';
  const offsetStr = c.req.query('offset') ?? '0';
  const limit = Math.min(parseInt(limitStr, 10) || 50, 100);
  const offset = parseInt(offsetStr, 10) || 0;

  const [users, total] = await Promise.all([
    listUsers(c.env.DB, limit, offset),
    countUsers(c.env.DB),
  ]);
  return c.json({
    data: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      picture: u.picture,
      role: u.role,
      created_at: u.created_at,
    })),
    total,
  });
});

export default app;
