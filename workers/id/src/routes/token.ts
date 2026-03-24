import { Hono } from 'hono';
import type { HonoRequest } from 'hono';
import { findRefreshTokenByHash, findUserById, revokeRefreshToken, sha256, verifyAccessToken } from '@0g0-id/shared';
import type { IdpEnv, User } from '@0g0-id/shared';
import { externalApiRateLimitMiddleware } from '../middleware/rate-limit';
import { authenticateService } from '../utils/service-auth';
import { parseAllowedScopes } from '../utils/scopes';

const app = new Hono<{ Bindings: IdpEnv }>();

/**
 * RFC 7009 / RFC 7662 準拠: リクエストボディのパース。
 * application/x-www-form-urlencoded（RFC標準）と application/json（後方互換）の両方に対応。
 */
async function parseTokenBody(
  req: HonoRequest
): Promise<{ token?: string; token_type_hint?: string } | null> {
  const contentType = req.header('Content-Type') ?? '';
  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const body = await req.parseBody();
      return {
        token: typeof body['token'] === 'string' ? body['token'] : undefined,
        token_type_hint:
          typeof body['token_type_hint'] === 'string' ? body['token_type_hint'] : undefined,
      };
    }
    return await req.json<{ token?: string; token_type_hint?: string }>();
  } catch {
    return null;
  }
}

/**
 * スコープに基づいてイントロスペクションレスポンスへユーザークレームを付与する。
 * refresh_token / access_token の両ブランチで共通利用。
 */
function applyUserClaims(
  claims: Record<string, unknown>,
  user: User,
  scopes: string[]
): void {
  if (scopes.includes('profile')) {
    claims['name'] = user.name;
    claims['picture'] = user.picture;
  }
  if (scopes.includes('email')) {
    claims['email'] = user.email;
    claims['email_verified'] = user.email_verified === 1;
  }
  if (scopes.includes('phone')) {
    claims['phone'] = user.phone;
  }
  if (scopes.includes('address')) {
    claims['address'] = user.address;
  }
}

// POST /api/token/introspect — RFC 7662 トークンイントロスペクション
app.post('/introspect', externalApiRateLimitMiddleware, async (c) => {
  // Basic認証でサービス認証
  let service: Awaited<ReturnType<typeof authenticateService>>;
  try {
    service = await authenticateService(c.env.DB, c.req.header('Authorization'));
  } catch {
    return c.json({ active: false }, 500);
  }
  if (!service) {
    return c.json({ active: false }, 401);
  }

  // トークン取得（RFC 7662: application/x-www-form-urlencoded および application/json に対応）
  const body = await parseTokenBody(c.req);
  if (!body) {
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

    const allowedScopes = parseAllowedScopes(service.allowed_scopes);

    // ペアワイズsub: 内部IDを直接公開しないようにsha256(client_id:user_id)を使用
    const sub = await sha256(service.client_id + ':' + refreshToken.user_id);

    const response: Record<string, unknown> = {
      active: true,
      sub,
      exp: Math.floor(new Date(refreshToken.expires_at).getTime() / 1000),
      scope: allowedScopes.join(' '),
    };

    applyUserClaims(response, user, allowedScopes);

    return c.json(response);
  }

  // JWTアクセストークンのイントロスペクション（RFC 7662）
  // リフレッシュトークンとして見つからなかった場合、JWTとして検証を試みる
  try {
    const payload = await verifyAccessToken(
      body.token,
      c.env.JWT_PUBLIC_KEY,
      c.env.IDP_ORIGIN,
      c.env.IDP_ORIGIN
    );

    // BFFセッショントークン（cid未設定）は外部サービスからイントロスペクト不可
    if (!payload.cid || payload.cid !== service.client_id) {
      return c.json({ active: false });
    }

    const tokenUser = await findUserById(c.env.DB, payload.sub);
    if (!tokenUser) {
      return c.json({ active: false });
    }

    const allowedScopes = parseAllowedScopes(service.allowed_scopes);
    const sub = await sha256(service.client_id + ':' + payload.sub);

    const jwtResponse: Record<string, unknown> = {
      active: true,
      sub,
      exp: payload.exp,
      scope: payload.scope ?? allowedScopes.join(' '),
      token_type: 'access_token',
    };

    applyUserClaims(jwtResponse, tokenUser, allowedScopes);

    return c.json(jwtResponse);
  } catch {
    // JWT検証失敗（期限切れ・署名不正など）
    return c.json({ active: false });
  }
});

// POST /api/token/revoke — RFC 7009 トークン失効
app.post('/revoke', externalApiRateLimitMiddleware, async (c) => {
  // Basic認証でサービス認証
  let service: Awaited<ReturnType<typeof authenticateService>>;
  try {
    service = await authenticateService(c.env.DB, c.req.header('Authorization'));
  } catch {
    return c.json({ error: 'invalid_client' }, 500);
  }
  if (!service) {
    return c.json({ error: 'invalid_client' }, 401);
  }

  // トークン取得（RFC 7009: application/x-www-form-urlencoded および application/json に対応）
  const body = await parseTokenBody(c.req);
  if (!body) {
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
