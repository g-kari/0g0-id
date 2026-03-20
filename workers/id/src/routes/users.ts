import { Hono } from 'hono';
import { z } from 'zod';
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
  getUserProviders,
  unlinkProvider,
  type UserFilter,
} from '@0g0-id/shared';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import { csrfMiddleware } from '../middleware/csrf';

const PatchMeSchema = z.object({
  name: z.string().min(1, 'name is required'),
  picture: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
});

const PatchRoleSchema = z.object({
  role: z.enum(['user', 'admin'], { message: 'role must be "user" or "admin"' }),
});

const VALID_PROVIDERS = ['google', 'line', 'twitch', 'github', 'x'] as const;

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

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  const parsed = PatchMeSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid request' } }, 400);
  }
  const body = parsed.data;

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

// GET /api/users/me/providers — 連携済みSNSプロバイダー一覧
app.get('/me/providers', authMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const providers = await getUserProviders(c.env.DB, tokenUser.sub);
  return c.json({ data: providers });
});

// DELETE /api/users/me/providers/:provider — SNSプロバイダー連携解除
app.delete('/me/providers/:provider', authMiddleware, csrfMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const providerParam = c.req.param('provider');
  if (!VALID_PROVIDERS.includes(providerParam as (typeof VALID_PROVIDERS)[number])) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid provider' } }, 400);
  }
  const provider = providerParam as (typeof VALID_PROVIDERS)[number];

  // 最後のプロバイダーは解除不可（ログインできなくなる）、また未連携プロバイダーのチェックも実施
  const providers = await getUserProviders(c.env.DB, tokenUser.sub);
  const targetProvider = providers.find((p) => p.provider === provider);
  if (!targetProvider?.connected) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Provider not connected' } }, 404);
  }
  const connectedCount = providers.filter((p) => p.connected).length;
  if (connectedCount <= 1) {
    return c.json(
      { error: { code: 'LAST_PROVIDER', message: 'Cannot unlink the last provider' } },
      409
    );
  }

  await unlinkProvider(c.env.DB, tokenUser.sub, provider);

  return c.body(null, 204);
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

// GET /api/users/:id（管理者のみ）
app.get('/:id', authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param('id');
  const user = await findUserById(c.env.DB, targetId);
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
      created_at: user.created_at,
      updated_at: user.updated_at,
    },
  });
});

// PATCH /api/users/:id/role（管理者のみ）
app.patch('/:id/role', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param('id');
  const tokenUser = c.get('user');

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  const parsed = PatchRoleSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid request' } },
      400
    );
  }
  const { role } = parsed.data;

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

  const user = await updateUserRole(c.env.DB, targetId, role);
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

  const filter: UserFilter = {};
  const emailQuery = c.req.query('email');
  const roleQuery = c.req.query('role');
  const nameQuery = c.req.query('name');

  if (emailQuery) filter.email = emailQuery;
  if (roleQuery === 'user' || roleQuery === 'admin') filter.role = roleQuery;
  if (nameQuery) filter.name = nameQuery;

  const [users, total] = await Promise.all([
    listUsers(c.env.DB, limit, offset, filter),
    countUsers(c.env.DB, filter),
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
