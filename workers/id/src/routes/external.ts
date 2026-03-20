import { Hono } from 'hono';
import {
  findUserById,
  findServiceByClientId,
  sha256,
  timingSafeEqual,
  hasUserAuthorizedService,
  listUsersAuthorizedForService,
  countUsersAuthorizedForService,
} from '@0g0-id/shared';
import type { IdpEnv, User, Service } from '@0g0-id/shared';
import { externalApiRateLimitMiddleware } from '../middleware/rate-limit';

const app = new Hono<{ Bindings: IdpEnv }>();

// スコープ→フィールド抽出のマップ（スコープ追加時はここに追記するだけ）
const SCOPE_FIELDS: Record<string, (u: User) => Record<string, unknown>> = {
  profile: (u) => ({ name: u.name, picture: u.picture }),
  email: (u) => ({ email: u.email, email_verified: u.email_verified === 1 }),
  phone: (u) => ({ phone: u.phone }),
  address: (u) => ({ address: u.address }),
};

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

  try {
    const service = await findServiceByClientId(db, clientId);
    if (!service) return null;

    const secretHash = await sha256(clientSecret);
    if (!timingSafeEqual(secretHash, service.client_secret_hash)) return null;

    return service;
  } catch {
    // DB障害・暗号処理エラーは認証失敗として扱い、呼び出し元で500を返す
    throw new Error('Service authentication failed due to internal error');
  }
}

/**
 * サービス固有の不透明なユーザー識別子（ペアワイズsub）を生成する。
 * 内部IDを直接公開しないために、sha256(client_id:user_id)を使用する。
 */
async function generatePairwiseSub(service: Service, userId: string): Promise<string> {
  return sha256(service.client_id + ':' + userId);
}

/**
 * スコープに基づいてユーザー情報をフィルタリングし、外部向けレスポンスを構築する。
 * 内部IDの代わりにペアワイズsubを返す。
 */
async function buildUserData(
  service: Service,
  user: User,
  allowedScopes: string[]
): Promise<Record<string, unknown>> {
  const sub = await generatePairwiseSub(service, user.id);
  const data: Record<string, unknown> = { sub };
  for (const scope of allowedScopes) {
    if (scope in SCOPE_FIELDS) {
      Object.assign(data, SCOPE_FIELDS[scope](user));
    }
  }
  return data;
}

/**
 * allowed_scopesをパースする。失敗時はfail-closed（空配列）。
 */
function parseAllowedScopes(service: Service): string[] {
  try {
    const scopes = JSON.parse(service.allowed_scopes) as string[];
    return Array.isArray(scopes) ? scopes : [];
  } catch {
    return [];
  }
}

// GET /api/external/users — 認可済みユーザー一覧（外部サービス向け）
app.get('/users', externalApiRateLimitMiddleware, async (c) => {
  let service: Awaited<ReturnType<typeof authenticateService>>;
  try {
    service = await authenticateService(c.env.DB, c.req.header('Authorization'));
  } catch {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
  }
  if (!service) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid client credentials' } }, 401);
  }

  // ページネーションパラメータのパース（Number + isInteger で厳密検証）
  const limitRaw = Number(c.req.query('limit') ?? '50');
  const offsetRaw = Number(c.req.query('offset') ?? '0');
  const limit =
    Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 50;
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  let users: User[];
  let total: number;
  try {
    [users, total] = await Promise.all([
      listUsersAuthorizedForService(c.env.DB, service.id, limit, offset),
      countUsersAuthorizedForService(c.env.DB, service.id),
    ]);
  } catch {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
  }

  const allowedScopes = parseAllowedScopes(service);

  const data = await Promise.all(users.map((user) => buildUserData(service!, user, allowedScopes)));

  return c.json({ data, meta: { total, limit, offset } });
});

// GET /api/external/users/:id — IDによるユーザー完全一致検索（外部サービス向け）
app.get('/users/:id', externalApiRateLimitMiddleware, async (c) => {
  let service: Awaited<ReturnType<typeof authenticateService>>;
  try {
    service = await authenticateService(c.env.DB, c.req.header('Authorization'));
  } catch {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
  }
  if (!service) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid client credentials' } }, 401);
  }

  const userId = c.req.param('id');

  let authorized: boolean;
  let user: Awaited<ReturnType<typeof findUserById>>;
  try {
    // ユーザーがサービスを認可済みか確認（IDOR防止）
    authorized = await hasUserAuthorizedService(c.env.DB, userId, service.id);
    if (!authorized) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
    }
    user = await findUserById(c.env.DB, userId);
  } catch {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
  }
  if (!user) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const allowedScopes = parseAllowedScopes(service);
  const data = await buildUserData(service, user, allowedScopes);

  return c.json({ data });
});

export default app;
