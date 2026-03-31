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
  revokeOtherUserTokens,
  listActiveSessionsByUserId,
  countServicesByOwner,
  listServicesByOwner,
  getUserProviders,
  unlinkProvider,
  getLoginEventsByUserId,
  getUserLoginProviderStats,
  getUserDailyLoginTrends,
  banUser,
  unbanUser,
  createAdminAuditLog,
  parsePagination,
  type UserFilter,
  createLogger,
} from '@0g0-id/shared';
import type { IdpEnv, TokenPayload, User } from '@0g0-id/shared';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import { csrfMiddleware } from '../middleware/csrf';
import { parseJsonBody } from '../utils/parse-body';

const PatchMeSchema = z.object({
  name: z.string().min(1, 'name is required').max(100, 'name must be 100 characters or less'),
  picture: z
    .string()
    .url('picture must be a valid URL')
    .startsWith('https://', 'picture must use HTTPS')
    .max(2048, 'picture URL must be 2048 characters or less')
    .nullable()
    .optional(),
  phone: z.string().max(50, 'phone must be 50 characters or less').nullable().optional(),
  address: z.string().max(500, 'address must be 500 characters or less').nullable().optional(),
});

const PatchRoleSchema = z.object({
  role: z.enum(['user', 'admin'], { message: 'role must be "user" or "admin"' }),
});

const RevokeOthersSchema = z.object({
  token_hash: z.string().min(1, 'token_hash is required'),
});

const VALID_PROVIDERS = ['google', 'line', 'twitch', 'github', 'x'] as const;

type Variables = { user: TokenPayload };

const usersLogger = createLogger('users');

// ─── レスポンスシリアライズヘルパー ──────────────────────────────────────────

/** /me 系エンドポイントのユーザープロフィール形式 */
function formatMyProfile(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    phone: user.phone,
    address: user.address,
    role: user.role,
  };
}

/** 管理者向けユーザー詳細形式（全フィールド） */
function formatAdminUserDetail(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    phone: user.phone,
    address: user.address,
    role: user.role,
    banned_at: user.banned_at,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

/** 管理者向けユーザーサマリー形式（一覧・ロール変更レスポンス用） */
function formatAdminUserSummary(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    role: user.role,
    banned_at: user.banned_at,
    created_at: user.created_at,
  };
}

/**
 * ユーザー削除の共通ロジック（サービス所有権チェック→トークン失効→削除）。
 * 削除不可の場合は error オブジェクトを返し、成功時は null を返す。
 */
async function performUserDeletion(
  db: D1Database,
  userId: string
): Promise<{ code: string; message: string } | null> {
  const ownedServices = await countServicesByOwner(db, userId);
  if (ownedServices > 0) {
    return {
      code: 'CONFLICT',
      message: `User owns ${ownedServices} service(s). Transfer ownership before deleting.`,
    };
  }
  await revokeUserTokens(db, userId, 'admin_action');
  await deleteUser(db, userId);
  return null;
}

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/users/me
app.get('/me', authMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const user = await findUserById(c.env.DB, tokenUser.sub);
  if (!user) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }
  return c.json({ data: formatMyProfile(user) });
});

// GET /api/users/me/data-export — GDPR準拠のアカウントデータ一括エクスポート
app.get('/me/data-export', authMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const userId = tokenUser.sub;

  const user = await findUserById(c.env.DB, userId);
  if (!user) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const [providers, connections, { events: loginHistory }, sessions] = await Promise.all([
    getUserProviders(c.env.DB, userId),
    listUserConnections(c.env.DB, userId),
    getLoginEventsByUserId(c.env.DB, userId, 1000, 0),
    listActiveSessionsByUserId(c.env.DB, userId),
  ]);

  return c.json({
    data: {
      exported_at: new Date().toISOString(),
      profile: {
        id: user.id,
        email: user.email,
        email_verified: user.email_verified === 1,
        name: user.name,
        picture: user.picture,
        phone: user.phone,
        address: user.address,
        role: user.role,
        created_at: user.created_at,
        updated_at: user.updated_at,
      },
      providers,
      service_connections: connections,
      login_history: loginHistory,
      active_sessions: sessions,
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

  let user: User;
  try {
    user = await updateUserProfile(c.env.DB, tokenUser.sub, profileUpdate);
  } catch {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  return c.json({ data: formatMyProfile(user) });
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
  const provider = c.req.query('provider') || undefined;

  const { events, total } = await getLoginEventsByUserId(c.env.DB, tokenUser.sub, limit, offset, provider);
  return c.json({ data: events, total });
});

// GET /api/users/me/login-stats — 自分のプロバイダー別ログイン統計
app.get('/me/login-stats', authMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const daysParam = c.req.query('days');
  const days = daysParam !== undefined ? parseInt(daysParam, 10) : 30;
  if (isNaN(days) || days < 1 || days > 90) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'days は1〜90の整数で指定してください' } },
      400
    );
  }
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const stats = await getUserLoginProviderStats(c.env.DB, tokenUser.sub, sinceIso);
  return c.json({ data: stats, days });
});

// GET /api/users/me/login-trends — 自分の日別ログイントレンド
app.get('/me/login-trends', authMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const daysParam = c.req.query('days');
  const days = daysParam !== undefined ? parseInt(daysParam, 10) : 30;
  if (isNaN(days) || days < 1 || days > 90) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'days は1〜90の整数で指定してください' } },
      400
    );
  }
  const trends = await getUserDailyLoginTrends(c.env.DB, tokenUser.sub, days);
  return c.json({ data: trends, days });
});

// GET /api/users/me/security-summary — セキュリティ概要
app.get('/me/security-summary', authMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const userId = tokenUser.sub;

  const [sessions, connections, loginHistory, providers, user] = await Promise.all([
    listActiveSessionsByUserId(c.env.DB, userId),
    listUserConnections(c.env.DB, userId),
    getLoginEventsByUserId(c.env.DB, userId, 1, 0),
    getUserProviders(c.env.DB, userId),
    findUserById(c.env.DB, userId),
  ]);

  if (!user) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const linkedProviders = providers.filter((p) => p.connected).map((p) => p.provider);
  const lastLoginEvent = loginHistory.events[0] ?? null;

  return c.json({
    data: {
      active_sessions_count: sessions.length,
      connected_services_count: connections.length,
      linked_providers: linkedProviders,
      last_login: lastLoginEvent
        ? {
            provider: lastLoginEvent.provider,
            ip_address: lastLoginEvent.ip_address,
            created_at: lastLoginEvent.created_at,
          }
        : null,
      account_created_at: user.created_at,
    },
  });
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
  const revoked = await revokeUserServiceTokens(c.env.DB, tokenUser.sub, serviceId, 'user_logout');
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

// DELETE /api/users/me/tokens/others — 現在のセッション以外を全て失効（他デバイスからのサインアウト）
app.delete('/me/tokens/others', authMiddleware, csrfMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const result = await parseJsonBody(c, RevokeOthersSchema);
  if (!result.ok) return result.response;
  const { token_hash } = result.data;

  const count = await revokeOtherUserTokens(c.env.DB, tokenUser.sub, token_hash, 'user_logout_others');
  return c.json({ data: { revoked_count: count } });
});

// DELETE /api/users/me/tokens/:tokenId — 特定セッションのみログアウト（単一リフレッシュトークン無効化）
app.delete('/me/tokens/:tokenId', authMiddleware, csrfMiddleware, async (c) => {
  const tokenUser = c.get('user');
  const tokenId = c.req.param('tokenId');
  const revoked = await revokeTokenByIdForUser(c.env.DB, tokenId, tokenUser.sub, 'user_logout');
  if (revoked === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);
  }
  return c.body(null, 204);
});

// DELETE /api/users/me/tokens — 全デバイスからログアウト（全リフレッシュトークン無効化）
app.delete('/me/tokens', authMiddleware, csrfMiddleware, async (c) => {
  const tokenUser = c.get('user');
  await revokeUserTokens(c.env.DB, tokenUser.sub, 'user_logout_all');
  return c.body(null, 204);
});

// DELETE /api/users/me — 自分のアカウントを削除
app.delete('/me', authMiddleware, csrfMiddleware, async (c) => {
  const tokenUser = c.get('user');

  const targetUser = await findUserById(c.env.DB, tokenUser.sub);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const deleteError = await performUserDeletion(c.env.DB, tokenUser.sub);
  if (deleteError) {
    return c.json({ error: deleteError }, 409);
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
  return c.json({ data: formatAdminUserDetail(user) });
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
  const provider = c.req.query('provider') || undefined;

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const { events, total } = await getLoginEventsByUserId(c.env.DB, targetId, limit, offset, provider);
  return c.json({ data: events, total });
});

// GET /api/users/:id/login-stats — ユーザーのプロバイダー別ログイン統計（管理者のみ）
app.get('/:id/login-stats', authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param('id');
  const daysParam = c.req.query('days');
  const days = daysParam !== undefined ? parseInt(daysParam, 10) : 30;
  if (isNaN(days) || days < 1 || days > 90) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'days は1〜90の整数で指定してください' } },
      400
    );
  }

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const stats = await getUserLoginProviderStats(c.env.DB, targetId, sinceIso);
  return c.json({ data: stats, days });
});

// GET /api/users/:id/login-trends — ユーザーの日別ログイントレンド（管理者のみ）
app.get('/:id/login-trends', authMiddleware, adminMiddleware, async (c) => {
  const targetId = c.req.param('id');
  const daysParam = c.req.query('days');
  const days = daysParam !== undefined ? parseInt(daysParam, 10) : 30;
  if (isNaN(days) || days < 1 || days > 90) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'days は1〜90の整数で指定してください' } },
      400
    );
  }

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const trends = await getUserDailyLoginTrends(c.env.DB, targetId, days);
  return c.json({ data: trends, days });
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

  const ipAddress = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null;
  let user;
  try {
    user = await updateUserRole(c.env.DB, targetId, role);
    // ロール変更後、既存トークンを即時失効（権限変更を即反映）
    await revokeUserTokens(c.env.DB, targetId, 'security_event');
    await createAdminAuditLog(c.env.DB, {
      adminUserId: tokenUser.sub,
      action: 'user.role_change',
      targetType: 'user',
      targetId,
      details: { from: targetUser.role, to: role },
      ipAddress,
      status: 'success',
    });
  } catch (err) {
    try {
      await createAdminAuditLog(c.env.DB, {
        adminUserId: tokenUser.sub,
        action: 'user.role_change',
        targetType: 'user',
        targetId,
        details: { from: targetUser.role, to: role, error: err instanceof Error ? err.message : 'Unknown error' },
        ipAddress,
        status: 'failure',
      });
    } catch { /* ログ記録エラーは無視 */ }
    throw err;
  }

  return c.json({ data: formatAdminUserSummary(user) });
});

// PATCH /api/users/:id/ban — ユーザーを停止（管理者のみ）
app.patch('/:id/ban', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param('id');
  const tokenUser = c.get('user');

  // 自分自身を停止不可
  if (targetId === tokenUser.sub) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot ban yourself' } }, 403);
  }

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  // 管理者を停止不可
  if (targetUser.role === 'admin') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot ban an admin user' } }, 403);
  }

  if (targetUser.banned_at !== null) {
    return c.json({ error: { code: 'CONFLICT', message: 'User is already banned' } }, 409);
  }

  const ipAddress = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null;
  let updated;
  try {
    updated = await banUser(c.env.DB, targetId);
    // 停止と同時に全セッション失効
    await revokeUserTokens(c.env.DB, targetId, 'security_event');
  } catch (err) {
    try {
      await createAdminAuditLog(c.env.DB, {
        adminUserId: tokenUser.sub,
        action: 'user.ban',
        targetType: 'user',
        targetId,
        details: { error: err instanceof Error ? err.message : 'Unknown error' },
        ipAddress,
        status: 'failure',
      });
    } catch { /* ログ記録エラーは無視 */ }
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to ban user' } }, 500);
  }

  try {
    await createAdminAuditLog(c.env.DB, {
      adminUserId: tokenUser.sub,
      action: 'user.ban',
      targetType: 'user',
      targetId,
      ipAddress,
      status: 'success',
    });
  } catch (err) {
    usersLogger.error('Failed to create audit log for user.ban', err);
  }

  return c.json({ data: formatAdminUserSummary(updated) });
});

// DELETE /api/users/:id/ban — ユーザー停止を解除（管理者のみ）
app.delete('/:id/ban', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param('id');
  const tokenUser = c.get('user');

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  if (targetUser.banned_at === null) {
    return c.json({ error: { code: 'CONFLICT', message: 'User is not banned' } }, 409);
  }

  const ipAddress = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null;
  let updated;
  try {
    updated = await unbanUser(c.env.DB, targetId);
    await createAdminAuditLog(c.env.DB, {
      adminUserId: tokenUser.sub,
      action: 'user.unban',
      targetType: 'user',
      targetId,
      ipAddress,
      status: 'success',
    });
  } catch (err) {
    try {
      await createAdminAuditLog(c.env.DB, {
        adminUserId: tokenUser.sub,
        action: 'user.unban',
        targetType: 'user',
        targetId,
        details: { error: err instanceof Error ? err.message : 'Unknown error' },
        ipAddress,
        status: 'failure',
      });
    } catch { /* ログ記録エラーは無視 */ }
    throw err;
  }

  return c.json({ data: formatAdminUserSummary(updated) });
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

// DELETE /api/users/:id/tokens/:tokenId — ユーザーの特定セッションを失効（管理者のみ）
app.delete('/:id/tokens/:tokenId', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param('id');
  const tokenId = c.req.param('tokenId');
  const tokenUser = c.get('user');

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const ipAddress = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null;
  let revoked;
  try {
    revoked = await revokeTokenByIdForUser(c.env.DB, tokenId, targetId, 'admin_action');
  } catch (err) {
    try {
      await createAdminAuditLog(c.env.DB, {
        adminUserId: tokenUser.sub,
        action: 'user.session_revoked',
        targetType: 'user',
        targetId,
        details: { tokenId, error: err instanceof Error ? err.message : 'Unknown error' },
        ipAddress,
        status: 'failure',
      });
    } catch { /* ログ記録エラーは無視 */ }
    throw err;
  }

  if (revoked === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);
  }

  await createAdminAuditLog(c.env.DB, {
    adminUserId: tokenUser.sub,
    action: 'user.session_revoked',
    targetType: 'user',
    targetId,
    details: { tokenId },
    ipAddress,
    status: 'success',
  });

  return c.body(null, 204);
});

// DELETE /api/users/:id/tokens — ユーザーの全セッション無効化（管理者のみ）
app.delete('/:id/tokens', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const targetId = c.req.param('id');
  const tokenUser = c.get('user');

  const targetUser = await findUserById(c.env.DB, targetId);
  if (!targetUser) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const ipAddress = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null;
  try {
    await revokeUserTokens(c.env.DB, targetId, 'admin_action');
    await createAdminAuditLog(c.env.DB, {
      adminUserId: tokenUser.sub,
      action: 'user.sessions_revoked',
      targetType: 'user',
      targetId,
      ipAddress,
      status: 'success',
    });
  } catch (err) {
    try {
      await createAdminAuditLog(c.env.DB, {
        adminUserId: tokenUser.sub,
        action: 'user.sessions_revoked',
        targetType: 'user',
        targetId,
        details: { error: err instanceof Error ? err.message : 'Unknown error' },
        ipAddress,
        status: 'failure',
      });
    } catch { /* ログ記録エラーは無視 */ }
    throw err;
  }

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

  const deleteError = await performUserDeletion(c.env.DB, targetId);
  if (deleteError) {
    return c.json({ error: deleteError }, 409);
  }

  try {
    await createAdminAuditLog(c.env.DB, {
      adminUserId: tokenUser.sub,
      action: 'user.delete',
      targetType: 'user',
      targetId,
      ipAddress: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
      status: 'success',
    });
  } catch (err) {
    usersLogger.error('Failed to create audit log for user.delete', err);
  }

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
  const bannedQuery = c.req.query('banned');

  if (emailQuery) filter.email = emailQuery;
  if (roleQuery === 'user' || roleQuery === 'admin') filter.role = roleQuery;
  if (nameQuery) filter.name = nameQuery;
  if (bannedQuery === 'true') filter.banned = true;
  else if (bannedQuery === 'false') filter.banned = false;

  const [users, total] = await Promise.all([
    listUsers(c.env.DB, limit, offset, filter),
    countUsers(c.env.DB, filter),
  ]);
  return c.json({ data: users.map(formatAdminUserSummary), total });
});

export default app;
