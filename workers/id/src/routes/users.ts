import { Hono } from 'hono';
import {
  findUserById,
  listUsers,
  countUsers,
  updateUserProfile,
  updateUserRole,
  deleteUser,
  listUserConnections,
  revokeUserServiceTokens,
  revokeUserTokens,
  countServicesByOwner,
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

  let body: { name?: string; picture?: string | null; phone?: string | null; address?: string | null };
  try {
    body = await c.req.json<{ name?: string; picture?: string | null; phone?: string | null; address?: string | null }>();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'name is required' } }, 400);
  }

  if (body.picture !== undefined && body.picture !== null && typeof body.picture !== 'string') {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'picture must be a string or null' } }, 400);
  }

  if (body.phone !== undefined && body.phone !== null && typeof body.phone !== 'string') {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'phone must be a string or null' } }, 400);
  }

  if (body.address !== undefined && body.address !== null && typeof body.address !== 'string') {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'address must be a string or null' } }, 400);
  }

  const profileUpdate: { name: string; picture?: string | null; phone?: string | null; address?: string | null } = {
    name: body.name.trim(),
  };
  if ('picture' in body) profileUpdate.picture = body.picture ? body.picture.trim() || null : null;
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

// PATCH /api/users/:id/role（管理者のみ）
app.patch('/:id/role', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param('id');
  const tokenUser = c.get('user');

  let body: { role?: string };
  try {
    body = await c.req.json<{ role?: string }>();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  if (body.role !== 'user' && body.role !== 'admin') {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'role must be "user" or "admin"' } },
      400
    );
  }

  // 自分自身のロールを変更不可（誤操作防止）
  if (targetId === tokenUser.sub) {
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'Cannot change your own role' } },
      403
    );
  }

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const user = await updateUserRole(c.env.DB, targetId, body.role);
  // ロール変更後、既存トークンを即時失効（権限変更を即反映）
  await revokeUserTokens(c.env.DB, targetId);

  return c.json({
    data: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      role: user.role,
      created_at: user.created_at,
    },
  });
});

// DELETE /api/users/:id（管理者のみ）
app.delete('/:id', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param('id');
  const tokenUser = c.get('user');

  // 自分自身の削除不可
  if (targetId === tokenUser.sub) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot delete yourself' } }, 403);
  }

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  // サービスの所有者である場合は削除不可（所有権を先に移譲すること）
  const ownedServices = await countServicesByOwner(c.env.DB, targetId);
  if (ownedServices > 0) {
    return c.json(
      {
        error: {
          code: 'CONFLICT',
          message: `User owns ${ownedServices} service(s). Transfer ownership before deleting.`,
        },
      },
      409
    );
  }

  // 削除前にトークンを失効
  await revokeUserTokens(c.env.DB, targetId);
  await deleteUser(c.env.DB, targetId);

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
