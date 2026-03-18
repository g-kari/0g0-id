import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  generateCodeVerifier,
  generateCodeChallenge,
  generateToken,
  sha256,
  signAccessToken,
  createRefreshToken,
  findRefreshTokenByHash,
  findUserById,
  revokeRefreshToken,
  revokeTokenFamily,
  upsertUser,
  updateUserRole,
  countAdminUsers,
  createAuthCode,
  findAndConsumeAuthCode,
} from '@0g0-id/shared';
import type { IdpEnv } from '@0g0-id/shared';

const app = new Hono<{ Bindings: IdpEnv }>();

const GOOGLE_REDIRECT_PATH = '/auth/callback';

// state/PKCE保存用Cookie名
const STATE_COOKIE = '__Host-oauth-state';
const PKCE_COOKIE = '__Host-oauth-pkce';

function setSecureCookie(
  c: Context<{ Bindings: IdpEnv }>,
  name: string,
  value: string,
  maxAge: number
): void {
  setCookie(c, name, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge,
  });
}

// GET /auth/login — BFFからのリダイレクト受け取り + Google認可へリダイレクト
app.get('/login', async (c) => {
  const redirectTo = c.req.query('redirect_to');
  const bffState = c.req.query('state');

  if (!redirectTo || !bffState) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing required parameters' } }, 400);
  }

  // redirect_toの検証（user/adminオリジンのみ許可）
  const allowedOrigins = [c.env.USER_ORIGIN, c.env.ADMIN_ORIGIN];
  const isAllowed = allowedOrigins.some((origin) => redirectTo.startsWith(origin + '/'));
  if (!isAllowed) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid redirect_to' } }, 400);
  }

  // id側のstate/PKCEを生成
  const idState = generateToken(16);
  const idCodeVerifier = generateCodeVerifier();
  const idCodeChallenge = await generateCodeChallenge(idCodeVerifier);

  // BFF情報をstate cookieに結びつけて保存
  const stateData = JSON.stringify({
    idState,
    bffState,
    redirectTo,
  });
  setSecureCookie(c, STATE_COOKIE, btoa(encodeURIComponent(stateData)), 600); // 10分
  setSecureCookie(c, PKCE_COOKIE, idCodeVerifier, 600);

  const callbackUri = `${c.env.IDP_ORIGIN}${GOOGLE_REDIRECT_PATH}`;
  const googleUrl = buildGoogleAuthUrl({
    clientId: c.env.GOOGLE_CLIENT_ID,
    redirectUri: callbackUri,
    state: idState,
    codeChallenge: idCodeChallenge,
  });

  return c.redirect(googleUrl);
});

// GET /auth/callback — Googleコールバック
app.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return c.json({ error: { code: 'OAUTH_ERROR', message: error } }, 400);
  }

  if (!code || !state) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing code or state' } }, 400);
  }

  // Cookie検証
  const stateCookieRaw = getCookie(c, STATE_COOKIE);
  const pkceVerifier = getCookie(c, PKCE_COOKIE);

  if (!stateCookieRaw || !pkceVerifier) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing session cookies' } }, 400);
  }

  let stateData: {
    idState: string;
    bffState: string;
    redirectTo: string;
  };
  try {
    stateData = JSON.parse(decodeURIComponent(atob(stateCookieRaw)));
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid state cookie' } }, 400);
  }

  // state検証
  if (state !== stateData.idState) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'State mismatch' } }, 400);
  }

  // Cookie削除（__Host- prefix には secure: true が必須）
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: true });
  deleteCookie(c, PKCE_COOKIE, { path: '/', secure: true });

  // Googleトークン交換
  const callbackUri = `${c.env.IDP_ORIGIN}${GOOGLE_REDIRECT_PATH}`;
  let googleTokens;
  try {
    googleTokens = await exchangeGoogleCode({
      code,
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: callbackUri,
      codeVerifier: pkceVerifier,
    });
  } catch {
    return c.json({ error: { code: 'OAUTH_ERROR', message: 'Failed to exchange code' } }, 400);
  }

  // ユーザー情報取得
  let userInfo;
  try {
    userInfo = await fetchGoogleUserInfo(googleTokens.access_token);
  } catch {
    return c.json({ error: { code: 'OAUTH_ERROR', message: 'Failed to fetch user info' } }, 400);
  }

  // email_verified必須チェック
  if (!userInfo.email_verified) {
    return c.json({ error: { code: 'UNVERIFIED_EMAIL', message: 'Email not verified' } }, 400);
  }

  // ユーザーupsert
  const userId = crypto.randomUUID();
  const user = await upsertUser(c.env.DB, {
    id: userId,
    googleSub: userInfo.sub,
    email: userInfo.email,
    emailVerified: userInfo.email_verified,
    name: userInfo.name,
    picture: userInfo.picture ?? null,
  });

  // 管理者ブートストラップ（管理者が0人の場合のみ）
  if (
    c.env.BOOTSTRAP_ADMIN_EMAIL &&
    user.email === c.env.BOOTSTRAP_ADMIN_EMAIL &&
    user.role !== 'admin' &&
    (await countAdminUsers(c.env.DB)) === 0
  ) {
    await updateUserRole(c.env.DB, user.id, 'admin');
    user.role = 'admin';
  }

  // ワンタイム認可コード発行
  const code60s = generateToken(32);
  const codeHash = await sha256(code60s);
  const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();

  await createAuthCode(c.env.DB, {
    id: crypto.randomUUID(),
    userId: user.id,
    codeHash,
    redirectTo: stateData.redirectTo,
    expiresAt,
  });

  // BFFコールバックへリダイレクト
  const callbackUrl = new URL(stateData.redirectTo);
  callbackUrl.searchParams.set('code', code60s);
  callbackUrl.searchParams.set('state', stateData.bffState);

  return c.redirect(callbackUrl.toString());
});

// POST /auth/exchange — ワンタイムコード交換（BFFサーバー間専用）
app.post('/exchange', async (c) => {
  let body: { code?: string };
  try {
    body = await c.req.json<{ code?: string }>();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  if (!body.code) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing code' } }, 400);
  }

  const codeHash = await sha256(body.code);
  const authCode = await findAndConsumeAuthCode(c.env.DB, codeHash);

  if (!authCode) {
    return c.json({ error: { code: 'INVALID_CODE', message: 'Invalid or expired code' } }, 400);
  }

  // ユーザー情報取得
  const user = await findUserById(c.env.DB, authCode.user_id);
  if (!user) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  // アクセストークン発行
  const accessToken = await signAccessToken(
    {
      iss: c.env.IDP_ORIGIN,
      sub: user.id,
      aud: c.env.IDP_ORIGIN,
      email: user.email,
      role: user.role,
    },
    c.env.JWT_PRIVATE_KEY,
    c.env.JWT_PUBLIC_KEY
  );

  // リフレッシュトークン発行
  const refreshTokenRaw = generateToken(32);
  const refreshTokenHash = await sha256(refreshTokenRaw);
  const familyId = crypto.randomUUID();
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await createRefreshToken(c.env.DB, {
    id: crypto.randomUUID(),
    userId: user.id,
    serviceId: null,
    tokenHash: refreshTokenHash,
    familyId,
    expiresAt: refreshExpiresAt,
  });

  return c.json({
    data: {
      access_token: accessToken,
      refresh_token: refreshTokenRaw,
      token_type: 'Bearer',
      expires_in: 900, // 15分
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        role: user.role,
      },
    },
  });
});

// POST /auth/refresh — トークンリフレッシュ（BFFサーバー間専用）
app.post('/refresh', async (c) => {
  let body: { refresh_token?: string };
  try {
    body = await c.req.json<{ refresh_token?: string }>();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  if (!body.refresh_token) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing refresh_token' } }, 400);
  }

  const tokenHash = await sha256(body.refresh_token);
  const storedToken = await findRefreshTokenByHash(c.env.DB, tokenHash);

  if (!storedToken) {
    return c.json({ error: { code: 'INVALID_TOKEN', message: 'Token not found' } }, 401);
  }

  // reuse detection: 既に失効済み → family全失効（リプレイ攻撃）
  if (storedToken.revoked_at !== null) {
    await revokeTokenFamily(c.env.DB, storedToken.family_id);
    return c.json({ error: { code: 'TOKEN_REUSE', message: 'Token reuse detected' } }, 401);
  }

  // 有効期限チェック
  if (new Date(storedToken.expires_at) < new Date()) {
    return c.json({ error: { code: 'TOKEN_EXPIRED', message: 'Refresh token expired' } }, 401);
  }

  // 旧トークンを失効
  await revokeRefreshToken(c.env.DB, storedToken.id);

  // ユーザー情報取得
  const user = await findUserById(c.env.DB, storedToken.user_id);
  if (!user) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  // 新アクセストークン発行
  const accessToken = await signAccessToken(
    {
      iss: c.env.IDP_ORIGIN,
      sub: user.id,
      aud: c.env.IDP_ORIGIN,
      email: user.email,
      role: user.role,
    },
    c.env.JWT_PRIVATE_KEY,
    c.env.JWT_PUBLIC_KEY
  );

  // 新リフレッシュトークン発行（ローテーション、同じfamily_id）
  const newRefreshTokenRaw = generateToken(32);
  const newRefreshTokenHash = await sha256(newRefreshTokenRaw);
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await createRefreshToken(c.env.DB, {
    id: crypto.randomUUID(),
    userId: user.id,
    serviceId: storedToken.service_id,
    tokenHash: newRefreshTokenHash,
    familyId: storedToken.family_id,
    expiresAt: refreshExpiresAt,
  });

  return c.json({
    data: {
      access_token: accessToken,
      refresh_token: newRefreshTokenRaw,
      token_type: 'Bearer',
      expires_in: 900,
    },
  });
});

// POST /auth/logout — ログアウト（BFFサーバー間専用）
app.post('/logout', async (c) => {
  let body: { refresh_token?: string };
  try {
    body = await c.req.json<{ refresh_token?: string }>();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  if (body.refresh_token) {
    const tokenHash = await sha256(body.refresh_token);
    const storedToken = await findRefreshTokenByHash(c.env.DB, tokenHash);
    if (storedToken) {
      await revokeTokenFamily(c.env.DB, storedToken.family_id);
    }
  }

  return c.json({ data: { success: true } });
});

export default app;
