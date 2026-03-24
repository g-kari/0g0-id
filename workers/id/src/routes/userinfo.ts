import { Hono, type Context } from 'hono';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { findUserById } from '@0g0-id/shared';
import { authMiddleware } from '../middleware/auth';
import { externalApiRateLimitMiddleware } from '../middleware/rate-limit';

type Variables = { user: TokenPayload };
type AppContext = Context<{ Bindings: IdpEnv; Variables: Variables }>;

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

/**
 * OIDC UserInfo エンドポイント共通ハンドラー。
 * OpenID Connect Core 1.0 Section 5.3 準拠。
 * アクセストークンで認証されたユーザーのクレームを返す。
 */
async function handleUserInfo(c: AppContext): Promise<Response> {
  const tokenUser = c.get('user');

  const user = await findUserById(c.env.DB, tokenUser.sub);
  if (!user) {
    return c.json({ error: 'invalid_token', error_description: 'User not found' }, 401);
  }

  // スコープベースのクレームフィルタリング（OIDC Core 1.0 Section 5.3）
  // scope未定義 = BFFセッション（全クレームを返す）
  // scope定義済み = サービストークン（スコープに応じてフィルタリング）
  const scopes = tokenUser.scope ? new Set(tokenUser.scope.split(' ')) : null;

  const claims: Record<string, unknown> = {
    sub: user.id,
    updated_at: Math.floor(new Date(user.updated_at).getTime() / 1000),
  };

  if (scopes === null || scopes.has('profile')) {
    claims.name = user.name;
    claims.picture = user.picture;
  }

  if (scopes === null || scopes.has('email')) {
    claims.email = user.email;
    claims.email_verified = user.email_verified === 1;
  }

  if (scopes !== null && scopes.has('phone') && user.phone !== null) {
    claims.phone_number = user.phone;
  }

  if (scopes !== null && scopes.has('address') && user.address !== null) {
    claims.address = { formatted: user.address };
  }

  return c.json(claims);
}

// GET /api/userinfo — OIDC UserInfo エンドポイント (OpenID Connect Core 1.0 Section 5.3)
app.get('/', externalApiRateLimitMiddleware, authMiddleware, handleUserInfo);

// POST /api/userinfo — OIDC Core 1.0 はGET/POSTの両方に対応することを要求
app.post('/', externalApiRateLimitMiddleware, authMiddleware, handleUserInfo);

export default app;
