import { Hono, type Context } from 'hono';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { findUserById } from '@0g0-id/shared';
import { authMiddleware } from '../middleware/auth';

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

  return c.json({
    sub: user.id,
    name: user.name,
    picture: user.picture,
    email: user.email,
    email_verified: user.email_verified === 1,
    updated_at: Math.floor(new Date(user.updated_at).getTime() / 1000),
  });
}

// GET /api/userinfo — OIDC UserInfo エンドポイント (OpenID Connect Core 1.0 Section 5.3)
app.get('/', authMiddleware, handleUserInfo);

// POST /api/userinfo — OIDC Core 1.0 はGET/POSTの両方に対応することを要求
app.post('/', authMiddleware, handleUserInfo);

export default app;
