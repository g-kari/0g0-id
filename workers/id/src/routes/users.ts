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
  revokeTokenByIdForUser,
  listActiveSessionsByUserId,
  countServicesByOwner,
  listServicesByOwner,
  getUserProviders,
  unlinkProvider,
  getLoginEventsByUserId,
  parsePagination,
  type UserFilter,
} from '@0g0-id/shared';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import { csrfMiddleware } from '../middleware/csrf';
import { parseJsonBody } from '../utils/parse-body';

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

  const result = await parseJsonBody(c, PatchMeSchema);
  if (!result.ok) return result.response;
  const body = result.data;

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

// GET /api/users/me/login-history — 自分のログイン履歴取得
app.get('/me/login-history', authMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const pagination = parsePagination(
    { limit: c.req.query('limit'), offset: c.req.query('offset') },
    { defaultLimit: 20, maxLimit: 100 }
  );
  if ('error' in pagination) {
    return c.json({ error: { code: 'BAD_REQUEST', message: pagination.error } }, 400);
  }
  const { limit, offset } = pagination;

  const { events, total } = await getLoginEventsByUserId(c.env.DB, tokenUser.sub, limit, offset);
  return c.json({ data: events, total });
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

// GET /api/users/me/tokens — アクティブセッション一覧
app.get('/me/tokens', authMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const sessions = await listActiveSessionsByUserId(c.env.DB, tokenUser.sub);
  return c.json({ data: sessions });
});

// DELETE /api/users/me/tokens/:tokenId — 特定セッションのみログアウト（単一リフレッシュトークン無効化）
app.delete('/me/tokens/:tokenId', authMiddleware, csrfMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const tokenId = c.req.param('tokenId');
  const revoked = await revokeTokenByIdForUser(c.env.DB, tokenId, tokenUser.sub);
  if (revoked === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);
  }
  return c.body(null, 204);
});

// DELETE /api/users/me/tokens — 全デバイスからログアウト（全リフレッシュトークン無効化）
app.delete('/me/tokens', authMiddleware, csrfMiddleware, async (c) => {
  const tokenUser = c.get('user');
  await revokeUserTokens(c.env.DB, tokenUser.sub);
  return c.body(null, 204);
});

// DELETE /api/users/me — 自分のアカウントを削除
app.delete('/me', authMiddleware, csrfMiddleware, async (c) => {
  const tokenUser = c.get('user');

  const targetUser = await findUserById(c.env.DB, tokenUser.sub);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  // サービスの所有者である場合は削除不可（所有権を先に移譲すること）
  const ownedServices = await countServicesByOwner(c.env.DB, tokenUser.sub);
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
  await revokeUserTokens(c.env.DB, tokenUser.sub);
  await deleteUser(c.env.DB, tokenUser.sub);

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

// GET /api/users/:id/owned-services — ユーザーが所有するサービス一覧（管理者のみ）
app.get('/:id/owned-services', authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param('id');

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const services = await listServicesByOwner(c.env.DB, targetId);
  return c.json({
    data: services.map((s) => ({
      id: s.id,
      name: s.name,
      client_id: s.client_id,
      allowed_scopes: s.allowed_scopes,
      created_at: s.created_at,
    })),
  });
});

// GET /api/users/:id/services — ユーザーが認可しているサービス一覧（管理者のみ）
app.get('/:id/services', authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param('id');

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const connections = await listUserConnections(c.env.DB, targetId);
  return c.json({ data: connections });
});

// GET /api/users/:id/providers — ユーザーのSNSプロバイダー連携状態（管理者のみ）
app.get('/:id/providers', authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param('id');

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const providers = await getUserProviders(c.env.DB, targetId);
  return c.json({ data: providers });
});

// GET /api/users/:id/login-history（管理者のみ）
app.get('/:id/login-history', authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param('id');
  const pagination = parsePagination(
    { limit: c.req.query('limit'), offset: c.req.query('offset') },
    { defaultLimit: 20, maxLimit: 100 }
  );
  if ('error' in pagination) {
    return c.json({ error: { code: 'BAD_REQUEST', message: pagination.error } }, 400);
  }
  const { limit, offset } = pagination;

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const { events, total } = await getLoginEventsByUserId(c.env.DB, targetId, limit, offset);
  return c.json({ data: events, total });
});

// PATCH /api/users/:id/role（管理者のみ）
app.patch('/:id/role', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param('id');
  const tokenUser = c.get('user');

  const result = await parseJsonBody(c, PatchRoleSchema);
  if (!result.ok) return result.response;
  const { role } = result.data;

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

// GET /api/users/:id/tokens — ユーザーのアクティブセッション一覧（管理者のみ）
app.get('/:id/tokens', authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param('id');

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const sessions = await listActiveSessionsByUserId(c.env.DB, targetId);
  return c.json({ data: sessions });
});

// DELETE /api/users/:id/tokens — ユーザーの全セッション無効化（管理者のみ）
app.delete('/:id/tokens', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param('id');

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  await revokeUserTokens(c.env.DB, targetId);
  return c.body(null, 204);
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
  const pagination = parsePagination(
    { limit: c.req.query('limit'), offset: c.req.query('offset') },
    { defaultLimit: 50, maxLimit: 100 }
  );
  if ('error' in pagination) {
    return c.json({ error: { code: 'BAD_REQUEST', message: pagination.error } }, 400);
  }
  const { limit, offset } = pagination;

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
