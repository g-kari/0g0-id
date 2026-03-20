import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { parseJsonBody } from '../utils/parse-body';

import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  buildLineAuthUrl,
  exchangeLineCode,
  fetchLineUserInfo,
  buildTwitchAuthUrl,
  exchangeTwitchCode,
  fetchTwitchUserInfo,
  buildGithubAuthUrl,
  exchangeGithubCode,
  fetchGithubUserInfo,
  fetchGithubPrimaryEmail,
  buildXAuthUrl,
  exchangeXCode,
  fetchXUserInfo,
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
  upsertLineUser,
  upsertTwitchUser,
  upsertGithubUser,
  upsertXUser,
  updateUserRole,
  countAdminUsers,
  createAuthCode,
  findAndConsumeAuthCode,
  linkProvider,
  insertLoginEvent,
} from '@0g0-id/shared';
import type { IdpEnv, User } from '@0g0-id/shared';
import { authRateLimitMiddleware } from '../middleware/rate-limit';

const ExchangeSchema = z.object({
  code: z.string().min(1, 'code is required'),
  redirect_to: z.string().min(1, 'redirect_to is required'),
});

const RefreshSchema = z.object({
  refresh_token: z.string().min(1, 'refresh_token is required'),
});

const LogoutSchema = z.object({
  refresh_token: z.string().optional(),
});

const app = new Hono<{ Bindings: IdpEnv }>();

const CALLBACK_PATH = '/auth/callback';

// state/PKCE保存用Cookie名
const STATE_COOKIE = '__Host-oauth-state';
const PKCE_COOKIE = '__Host-oauth-pkce';

type OAuthProvider = 'google' | 'line' | 'twitch' | 'github' | 'x';

// Google以外のプロバイダーの資格情報キー（オプション設定）
const OPTIONAL_PROVIDER_CREDENTIALS = {
  line: { id: 'LINE_CLIENT_ID' as const, secret: 'LINE_CLIENT_SECRET' as const, name: 'LINE' },
  twitch: { id: 'TWITCH_CLIENT_ID' as const, secret: 'TWITCH_CLIENT_SECRET' as const, name: 'Twitch' },
  github: { id: 'GITHUB_CLIENT_ID' as const, secret: 'GITHUB_CLIENT_SECRET' as const, name: 'GitHub' },
  x: { id: 'X_CLIENT_ID' as const, secret: 'X_CLIENT_SECRET' as const, name: 'X' },
} satisfies Record<Exclude<OAuthProvider, 'google'>, { id: keyof IdpEnv; secret: keyof IdpEnv; name: string }>;

const PROVIDER_DISPLAY_NAMES: Record<OAuthProvider, string> = {
  google: 'Google',
  line: 'LINE',
  twitch: 'Twitch',
  github: 'GitHub',
  x: 'X',
};

/** プロバイダー認証の解決結果 */
type ProviderResolution =
  | { ok: true; sub: string; upsert: (db: D1Database, id: string) => Promise<User> }
  | { ok: false; response: Response };

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

/**
 * SNSプロバイダー連携のラッパー。
 * PROVIDER_ALREADY_LINKEDエラーを捕捉し、判別可能な戻り値として返す。
 */
async function handleProviderLink(
  db: D1Database,
  linkUserId: string,
  provider: OAuthProvider,
  providerSub: string
): Promise<{ ok: true; user: User } | { ok: false }> {
  try {
    const user = await linkProvider(db, linkUserId, provider, providerSub);
    return { ok: true, user };
  } catch (err) {
    if (err instanceof Error && err.message === 'PROVIDER_ALREADY_LINKED') {
      return { ok: false };
    }
    throw err;
  }
}

// ─── プロバイダー固有の認証解決関数 ──────────────────────────────────────────

async function resolveGoogleProvider(
  c: Context<{ Bindings: IdpEnv }>,
  code: string,
  pkceVerifier: string,
  callbackUri: string
): Promise<ProviderResolution> {
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
    return { ok: false, response: c.json({ error: { code: 'OAUTH_ERROR', message: 'Failed to exchange code' } }, 400) };
  }

  let userInfo;
  try {
    userInfo = await fetchGoogleUserInfo(googleTokens.access_token);
  } catch {
    return { ok: false, response: c.json({ error: { code: 'OAUTH_ERROR', message: 'Failed to fetch user info' } }, 400) };
  }

  if (!userInfo.email_verified) {
    return { ok: false, response: c.json({ error: { code: 'UNVERIFIED_EMAIL', message: 'Email not verified' } }, 400) };
  }

  return {
    ok: true,
    sub: userInfo.sub,
    upsert: (db, id) =>
      upsertUser(db, {
        id,
        googleSub: userInfo.sub,
        email: userInfo.email,
        emailVerified: userInfo.email_verified,
        name: userInfo.name,
        picture: userInfo.picture ?? null,
      }),
  };
}

async function resolveLineProvider(
  c: Context<{ Bindings: IdpEnv }>,
  code: string,
  pkceVerifier: string,
  callbackUri: string
): Promise<ProviderResolution> {
  let lineTokens;
  try {
    lineTokens = await exchangeLineCode({
      code,
      clientId: c.env.LINE_CLIENT_ID!,
      clientSecret: c.env.LINE_CLIENT_SECRET!,
      redirectUri: callbackUri,
      codeVerifier: pkceVerifier,
    });
  } catch {
    return { ok: false, response: c.json({ error: { code: 'OAUTH_ERROR', message: 'Failed to exchange LINE code' } }, 400) };
  }

  let userInfo;
  try {
    userInfo = await fetchLineUserInfo(lineTokens.access_token);
  } catch {
    return { ok: false, response: c.json({ error: { code: 'OAUTH_ERROR', message: 'Failed to fetch LINE user info' } }, 400) };
  }

  const isPlaceholderEmail = !userInfo.email;
  const email = userInfo.email ?? `line_${userInfo.sub}@line.placeholder`;

  return {
    ok: true,
    sub: userInfo.sub,
    upsert: (db, id) =>
      upsertLineUser(db, {
        id,
        lineSub: userInfo.sub,
        email,
        isPlaceholderEmail,
        name: userInfo.name,
        picture: userInfo.picture ?? null,
      }),
  };
}

async function resolveTwitchProvider(
  c: Context<{ Bindings: IdpEnv }>,
  code: string,
  pkceVerifier: string,
  callbackUri: string
): Promise<ProviderResolution> {
  let twitchTokens;
  try {
    twitchTokens = await exchangeTwitchCode({
      code,
      clientId: c.env.TWITCH_CLIENT_ID!,
      clientSecret: c.env.TWITCH_CLIENT_SECRET!,
      redirectUri: callbackUri,
      codeVerifier: pkceVerifier,
    });
  } catch {
    return { ok: false, response: c.json({ error: { code: 'OAUTH_ERROR', message: 'Failed to exchange Twitch code' } }, 400) };
  }

  let userInfo;
  try {
    userInfo = await fetchTwitchUserInfo(twitchTokens.access_token);
  } catch {
    return { ok: false, response: c.json({ error: { code: 'OAUTH_ERROR', message: 'Failed to fetch Twitch user info' } }, 400) };
  }

  const isPlaceholderEmail = !userInfo.email;
  const email = userInfo.email ?? `twitch_${userInfo.sub}@twitch.placeholder`;

  return {
    ok: true,
    sub: userInfo.sub,
    upsert: (db, id) =>
      upsertTwitchUser(db, {
        id,
        twitchSub: userInfo.sub,
        email,
        isPlaceholderEmail,
        emailVerified: userInfo.email_verified ?? false,
        name: userInfo.preferred_username,
        picture: userInfo.picture ?? null,
      }),
  };
}

async function resolveGithubProvider(
  c: Context<{ Bindings: IdpEnv }>,
  code: string,
  pkceVerifier: string,
  callbackUri: string
): Promise<ProviderResolution> {
  let githubTokens;
  try {
    githubTokens = await exchangeGithubCode({
      code,
      clientId: c.env.GITHUB_CLIENT_ID!,
      clientSecret: c.env.GITHUB_CLIENT_SECRET!,
      redirectUri: callbackUri,
      codeVerifier: pkceVerifier,
    });
  } catch {
    return { ok: false, response: c.json({ error: { code: 'OAUTH_ERROR', message: 'Failed to exchange GitHub code' } }, 400) };
  }

  let githubUser;
  try {
    githubUser = await fetchGithubUserInfo(githubTokens.access_token);
  } catch {
    return { ok: false, response: c.json({ error: { code: 'OAUTH_ERROR', message: 'Failed to fetch GitHub user info' } }, 400) };
  }

  const githubSub = String(githubUser.id);
  let email = githubUser.email;
  if (!email) {
    email = await fetchGithubPrimaryEmail(githubTokens.access_token);
  }
  const isPlaceholderEmail = !email;
  const finalEmail = email ?? `github_${githubSub}@github.placeholder`;

  return {
    ok: true,
    sub: githubSub,
    upsert: (db, id) =>
      upsertGithubUser(db, {
        id,
        githubSub,
        email: finalEmail,
        isPlaceholderEmail,
        name: githubUser.name ?? githubUser.login,
        picture: githubUser.avatar_url,
      }),
  };
}

async function resolveXProvider(
  c: Context<{ Bindings: IdpEnv }>,
  code: string,
  pkceVerifier: string,
  callbackUri: string
): Promise<ProviderResolution> {
  let xTokens;
  try {
    xTokens = await exchangeXCode({
      code,
      clientId: c.env.X_CLIENT_ID!,
      clientSecret: c.env.X_CLIENT_SECRET!,
      redirectUri: callbackUri,
      codeVerifier: pkceVerifier,
    });
  } catch {
    return { ok: false, response: c.json({ error: { code: 'OAUTH_ERROR', message: 'Failed to exchange X code' } }, 400) };
  }

  let xUser;
  try {
    xUser = await fetchXUserInfo(xTokens.access_token);
  } catch {
    return { ok: false, response: c.json({ error: { code: 'OAUTH_ERROR', message: 'Failed to fetch X user info' } }, 400) };
  }

  const xEmail = `x_${xUser.id}@x.placeholder`;

  return {
    ok: true,
    sub: xUser.id,
    upsert: (db, id) =>
      upsertXUser(db, {
        id,
        xSub: xUser.id,
        email: xEmail,
        name: xUser.name ?? xUser.username,
        picture: xUser.profile_image_url ?? null,
      }),
  };
}

// ─── ルートハンドラー ──────────────────────────────────────────────────────────

// GET /auth/login — BFFからのリダイレクト受け取り + プロバイダー認可へリダイレクト
app.get('/login', authRateLimitMiddleware, async (c) => {
  const redirectTo = c.req.query('redirect_to');
  const bffState = c.req.query('state');
  const providerParam = c.req.query('provider') ?? 'google';
  const linkUserId = c.req.query('link_user_id');

  if (!redirectTo || !bffState) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing required parameters' } }, 400);
  }

  // providerの検証
  const validProviders: OAuthProvider[] = ['google', 'line', 'twitch', 'github', 'x'];
  if (!validProviders.includes(providerParam as OAuthProvider)) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid provider' } }, 400);
  }
  const provider = providerParam as OAuthProvider;

  // プロバイダー資格情報の確認（Google以外はオプション設定）
  if (provider !== 'google') {
    const creds = OPTIONAL_PROVIDER_CREDENTIALS[provider];
    if (!c.env[creds.id] || !c.env[creds.secret]) {
      return c.json(
        { error: { code: 'PROVIDER_NOT_CONFIGURED', message: `${creds.name} provider is not configured` } },
        400
      );
    }
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

  // BFF情報をstate cookieに結びつけて保存（providerも含める）
  const stateData = JSON.stringify({
    idState,
    bffState,
    redirectTo,
    provider,
    ...(linkUserId ? { linkUserId } : {}),
  });
  setSecureCookie(c, STATE_COOKIE, btoa(encodeURIComponent(stateData)), 600); // 10分
  setSecureCookie(c, PKCE_COOKIE, idCodeVerifier, 600);

  const callbackUri = `${c.env.IDP_ORIGIN}${CALLBACK_PATH}`;
  const commonParams = { redirectUri: callbackUri, state: idState, codeChallenge: idCodeChallenge };

  switch (provider) {
    case 'line':
      return c.redirect(buildLineAuthUrl({ ...commonParams, clientId: c.env.LINE_CLIENT_ID! }));
    case 'twitch':
      return c.redirect(buildTwitchAuthUrl({ ...commonParams, clientId: c.env.TWITCH_CLIENT_ID! }));
    case 'github':
      return c.redirect(buildGithubAuthUrl({ ...commonParams, clientId: c.env.GITHUB_CLIENT_ID! }));
    case 'x':
      return c.redirect(buildXAuthUrl({ ...commonParams, clientId: c.env.X_CLIENT_ID! }));
    case 'google':
      return c.redirect(buildGoogleAuthUrl({ ...commonParams, clientId: c.env.GOOGLE_CLIENT_ID }));
  }
});

// GET /auth/callback — OAuthコールバック（全プロバイダー共通）
app.get('/callback', authRateLimitMiddleware, async (c) => {
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
    provider: OAuthProvider;
    linkUserId?: string;
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

  const callbackUri = `${c.env.IDP_ORIGIN}${CALLBACK_PATH}`;
  const provider = stateData.provider ?? 'google';

  // Google以外はオプション設定のため資格情報の存在を確認
  if (provider !== 'google') {
    const creds = OPTIONAL_PROVIDER_CREDENTIALS[provider];
    if (!c.env[creds.id] || !c.env[creds.secret]) {
      return c.json(
        { error: { code: 'PROVIDER_NOT_CONFIGURED', message: `${creds.name} provider is not configured` } },
        400
      );
    }
  }

  // プロバイダー固有の認証処理（コード交換・ユーザー情報取得）
  const resolvers: Record<OAuthProvider, () => Promise<ProviderResolution>> = {
    google: () => resolveGoogleProvider(c, code, pkceVerifier, callbackUri),
    line: () => resolveLineProvider(c, code, pkceVerifier, callbackUri),
    twitch: () => resolveTwitchProvider(c, code, pkceVerifier, callbackUri),
    github: () => resolveGithubProvider(c, code, pkceVerifier, callbackUri),
    x: () => resolveXProvider(c, code, pkceVerifier, callbackUri),
  };
  const resolved = await resolvers[provider]();
  if (!resolved.ok) return resolved.response;

  // アカウント連携またはユーザー作成/更新
  const userId = crypto.randomUUID();
  let user: User;
  if (stateData.linkUserId) {
    const result = await handleProviderLink(c.env.DB, stateData.linkUserId, provider, resolved.sub);
    if (!result.ok) {
      return c.json(
        {
          error: {
            code: 'PROVIDER_ALREADY_LINKED',
            message: `This ${PROVIDER_DISPLAY_NAMES[provider]} account is already linked to another user`,
          },
        },
        409
      );
    }
    user = result.user;
  } else {
    user = await resolved.upsert(c.env.DB, userId);
  }

  // 管理者ブートストラップ（管理者が0人の場合のみ）
  if (
    c.env.BOOTSTRAP_ADMIN_EMAIL &&
    user.email === c.env.BOOTSTRAP_ADMIN_EMAIL &&
    user.role !== 'admin' &&
    (await countAdminUsers(c.env.DB)) === 0
  ) {
    try {
      await updateUserRole(c.env.DB, user.id, 'admin');
      user.role = 'admin';
    } catch (err) {
      console.error('[bootstrap] Failed to elevate bootstrap admin:', err);
    }
  }

  // ログインイベント記録（エラーがあってもログインフローは継続）
  try {
    const ipAddress =
      c.req.header('cf-connecting-ip') ??
      (c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null);
    const userAgent = c.req.header('user-agent') ?? null;
    await insertLoginEvent(c.env.DB, {
      userId: user.id,
      provider,
      ipAddress,
      userAgent,
    });
  } catch (err) {
    console.error('[login-event] Failed to record login event:', err);
  }

  // ワンタイム認可コード発行
  const authCode = generateToken(32);
  const codeHash = await sha256(authCode);
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
  callbackUrl.searchParams.set('code', authCode);
  callbackUrl.searchParams.set('state', stateData.bffState);

  return c.redirect(callbackUrl.toString());
});

// POST /auth/exchange — ワンタイムコード交換（BFFサーバー間専用）
app.post('/exchange', async (c) => {
  const result = await parseJsonBody(c, ExchangeSchema);
  if (!result.ok) return result.response;
  const body = result.data;

  const codeHash = await sha256(body.code);
  const authCode = await findAndConsumeAuthCode(c.env.DB, codeHash);

  if (!authCode) {
    return c.json({ error: { code: 'INVALID_CODE', message: 'Invalid or expired code' } }, 400);
  }

  // redirect_to の一致検証（認可コード横取り攻撃対策）
  if (authCode.redirect_to !== body.redirect_to) {
    return c.json({ error: { code: 'INVALID_CODE', message: 'redirect_to mismatch' } }, 400);
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
  const result = await parseJsonBody(c, RefreshSchema);
  if (!result.ok) return result.response;

  const tokenHash = await sha256(result.data.refresh_token);
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
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  const parsed = LogoutSchema.safeParse(rawBody);
  const refreshToken = parsed.success ? parsed.data.refresh_token : undefined;

  if (refreshToken) {
    const tokenHash = await sha256(refreshToken);
    const storedToken = await findRefreshTokenByHash(c.env.DB, tokenHash);
    if (storedToken) {
      await revokeTokenFamily(c.env.DB, storedToken.family_id);
    }
  }

  return c.json({ data: { success: true } });
});

export default app;
