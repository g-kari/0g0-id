import { Hono } from 'hono';
import {
  findRefreshTokenByHash,
  findServiceByClientId,
  findUserById,
  revokeRefreshToken,
  sha256,
  timingSafeEqual,
} from '@0g0-id/shared';
import type { IdpEnv } from '@0g0-id/shared';
import { externalApiRateLimitMiddleware } from '../middleware/rate-limit';

const app = new Hono<{ Bindings: IdpEnv }>();

// POST /api/token/introspect — RFC 7662 トークンイントロスペクション
app.post('/introspect', externalApiRateLimitMiddleware, async (c) => {
  // Basic認証でサービス認証
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Basic ')) {
    return c.json({ active: false }, 401);
  }

  let credentials: string;
  try {
    credentials = atob(authHeader.slice(6));
  } catch {
    return c.json({ active: false }, 401);
  }
  const colonIndex = credentials.indexOf(':');
  if (colonIndex === -1) {
    return c.json({ active: false }, 401);
  }

  const clientId = credentials.slice(0, colonIndex);
  const clientSecret = credentials.slice(colonIndex + 1);

  const service = await findServiceByClientId(c.env.DB, clientId);
  if (!service) {
    return c.json({ active: false }, 401);
  }

  const secretHash = await sha256(clientSecret);
  if (!timingSafeEqual(secretHash, service.client_secret_hash)) {
    return c.json({ active: false }, 401);
  }

  // トークン取得
  let body: { token?: string };
  try {
    body = await c.req.json<{ token?: string }>();
  } catch {
    return c.json({ active: false }, 400);
  }

  if (!body.token) {
    return c.json({ active: false }, 400);
  }

  // リフレッシュトークンの場合
  const tokenHash = await sha256(body.token);
  const refreshToken = await findRefreshTokenByHash(c.env.DB, tokenHash);

  if (refreshToken && refreshToken.revoked_at === null) {
    // サービス所有権確認: 自サービス向けに発行されたトークンのみ照会可能
    if (refreshToken.service_id !== service.id) {
      return c.json({ active: false });
    }
    const isExpired = new Date(refreshToken.expires_at) < new Date();
    if (isExpired) {
      return c.json({ active: false });
    }

    // ユーザー情報をallowed_scopesに基づいてフィルタリングして返却
    const user = await findUserById(c.env.DB, refreshToken.user_id);
    if (!user) {
      return c.json({ active: false });
    }

    let allowedScopes: string[];
    try {
      allowedScopes = JSON.parse(service.allowed_scopes) as string[];
    } catch {
      allowedScopes = ['profile', 'email'];
    }

    // ペアワイズsub: 内部IDを直接公開しないようにsha256(client_id:user_id)を使用
    const sub = await sha256(service.client_id + ':' + refreshToken.user_id);

    const response: Record<string, unknown> = {
      active: true,
      sub,
      exp: Math.floor(new Date(refreshToken.expires_at).getTime() / 1000),
      scope: allowedScopes.join(' '),
    };

    // scopeに応じてユーザー情報を付与
    if (allowedScopes.includes('profile')) {
      response['name'] = user.name;
      response['picture'] = user.picture;
    }
    if (allowedScopes.includes('email')) {
      response['email'] = user.email;
      response['email_verified'] = user.email_verified === 1;
    }
    if (allowedScopes.includes('phone')) {
      response['phone'] = user.phone;
    }
    if (allowedScopes.includes('address')) {
      response['address'] = user.address;
    }

    return c.json(response);
  }

  return c.json({ active: false });
});

// POST /api/token/revoke — RFC 7009 トークン失効
app.post('/revoke', externalApiRateLimitMiddleware, async (c) => {
  // Basic認証でサービス認証
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Basic ')) {
    return c.json({ error: 'invalid_client' }, 401);
  }

  let credentials: string;
  try {
    credentials = atob(authHeader.slice(6));
  } catch {
    return c.json({ error: 'invalid_client' }, 401);
  }
  const colonIndex = credentials.indexOf(':');
  if (colonIndex === -1) {
    return c.json({ error: 'invalid_client' }, 401);
  }

  const clientId = credentials.slice(0, colonIndex);
  const clientSecret = credentials.slice(colonIndex + 1);

  const service = await findServiceByClientId(c.env.DB, clientId);
  if (!service) {
    return c.json({ error: 'invalid_client' }, 401);
  }

  const secretHash = await sha256(clientSecret);
  if (!timingSafeEqual(secretHash, service.client_secret_hash)) {
    return c.json({ error: 'invalid_client' }, 401);
  }

  // トークン取得（JSON形式）
  let body: { token?: string; token_type_hint?: string };
  try {
    body = await c.req.json<{ token?: string; token_type_hint?: string }>();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }

  if (!body.token) {
    return c.json({ error: 'invalid_request' }, 400);
  }

  // リフレッシュトークンの失効処理
  const tokenHash = await sha256(body.token);
  const refreshToken = await findRefreshTokenByHash(c.env.DB, tokenHash);

  // RFC 7009: トークンが存在しない・失効済みでも 200 OK を返す（情報漏洩防止）
  // 自サービスが発行したトークンのみ失効可能
  if (refreshToken && refreshToken.revoked_at === null && refreshToken.service_id === service.id) {
    await revokeRefreshToken(c.env.DB, refreshToken.id);
  }

  return new Response(null, { status: 200 });
});

export default app;
