import { Hono } from 'hono';
import {
  findUserById,
  findServiceByClientId,
  sha256,
  timingSafeEqual,
  hasUserAuthorizedService,
} from '@0g0-id/shared';
import type { IdpEnv } from '@0g0-id/shared';

const app = new Hono<{ Bindings: IdpEnv }>();

/**
 * Basic認証でサービス認証を行い、サービス情報を返す。
 * 認証失敗時はnullを返す。
 */
async function authenticateService(db: D1Database, authHeader: string | undefined) {
  if (!authHeader?.startsWith('Basic ')) return null;

  let credentials: string;
  try {
    credentials = atob(authHeader.slice(6));
  } catch {
    return null;
  }

  const colonIndex = credentials.indexOf(':');
  if (colonIndex === -1) return null;

  const clientId = credentials.slice(0, colonIndex);
  const clientSecret = credentials.slice(colonIndex + 1);

  const service = await findServiceByClientId(db, clientId);
  if (!service) return null;

  const secretHash = await sha256(clientSecret);
  if (!timingSafeEqual(secretHash, service.client_secret_hash)) return null;

  return service;
}

// GET /api/external/users/:id — IDによるユーザー完全一致検索（外部サービス向け）
app.get('/users/:id', async (c) => {
  const service = await authenticateService(c.env.DB, c.req.header('Authorization'));
  if (!service) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid client credentials' } }, 401);
  }

  const userId = c.req.param('id');

  // ユーザーがサービスを認可済みか確認（IDOR防止）
  const authorized = await hasUserAuthorizedService(c.env.DB, userId, service.id);
  if (!authorized) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const user = await findUserById(c.env.DB, userId);
  if (!user) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  let allowedScopes: string[];
  try {
    allowedScopes = JSON.parse(service.allowed_scopes) as string[];
    if (!Array.isArray(allowedScopes)) allowedScopes = [];
  } catch {
    // 解析失敗時はfail-closed（情報を一切返さない）
    allowedScopes = [];
  }

  // allowed_scopesに基づいてユーザー情報をフィルタリング
  const data: Record<string, unknown> = { id: user.id };

  if (allowedScopes.includes('profile')) {
    data['name'] = user.name;
    data['picture'] = user.picture;
  }
  if (allowedScopes.includes('email')) {
    data['email'] = user.email;
    data['email_verified'] = user.email_verified === 1;
  }
  if (allowedScopes.includes('phone')) {
    data['phone'] = user.phone;
  }
  if (allowedScopes.includes('address')) {
    data['address'] = user.address;
  }

  return c.json({ data });
});

export default app;
