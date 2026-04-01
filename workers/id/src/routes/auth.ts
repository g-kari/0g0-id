import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { parseJsonBody } from '../utils/parse-body';
import { authenticateService } from '../utils/service-auth';
import { getClientIp } from '../utils/ip';

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
  signIdToken,
  createRefreshToken,
  findRefreshTokenByHash,
  findAndRevokeRefreshToken,
  unrevokeRefreshToken,
  findUserById,
  revokeRefreshToken,
  revokeTokenFamily,
  upsertUser,
  upsertLineUser,
  upsertTwitchUser,
  upsertGithubUser,
  upsertXUser,
  tryBootstrapAdmin,
  createAuthCode,
  findAndConsumeAuthCode,
  findServiceByClientId,
  findServiceById,
  isValidRedirectUri,
  timingSafeEqual,
  linkProvider,
  insertLoginEvent,
  createLogger,
} from '@0g0-id/shared';
import type { IdpEnv, TokenPayload, User } from '@0g0-id/shared';
import { type OAuthProvider, PROVIDER_DISPLAY_NAMES } from '@0g0-id/shared';
import { authRateLimitMiddleware, tokenApiRateLimitMiddleware } from '../middleware/rate-limit';
import { authMiddleware } from '../middleware/auth';
import { parseAllowedScopes } from '../utils/scopes';

const ExchangeSchema = z.object({
  code: z.string().min(1, 'code is required'),
  redirect_to: z.string().min(1, 'redirect_to is required').max(2048, 'redirect_to too long'),
  code_verifier: z.string().min(43).max(128).optional(),
});

const RefreshSchema = z.object({
  refresh_token: z.string().min(1, 'refresh_token is required'),
});

const LogoutSchema = z.object({
  refresh_token: z.string().optional(),
});

type Variables = { user: TokenPayload };

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

const authLogger = createLogger('auth');

const CALLBACK_PATH = '/auth/callback';

/**
 * OAuthプロバイダーから返されるエラーコードの安全なマッピング。
 * 未知のエラーコードはフォールバックメッセージに置き換え、
 * プロバイダーの内部情報をそのまま反射することを防ぐ。
 */
const OAUTH_ERROR_MAP: Record<string, string> = {
  access_denied: 'Access was denied',
  server_error: 'Authorization server error',
  temporarily_unavailable: 'Authorization server temporarily unavailable',
  invalid_request: 'Invalid request',
  unsupported_response_type: 'Unsupported response type',
  invalid_scope: 'Invalid scope requested',
  interaction_required: 'User interaction required',
  login_required: 'Login required',
  consent_required: 'User consent required',
  account_selection_required: 'Account selection required',
};

// state/PKCE保存用Cookie名
const STATE_COOKIE = '__Host-oauth-state';
const PKCE_COOKIE = '__Host-oauth-pkce';

// Google以外のプロバイダーの資格情報キー（オプション設定）
const OPTIONAL_PROVIDER_CREDENTIALS = {
  line: { id: 'LINE_CLIENT_ID' as const, secret: 'LINE_CLIENT_SECRET' as const, name: 'LINE' },
  twitch: { id: 'TWITCH_CLIENT_ID' as const, secret: 'TWITCH_CLIENT_SECRET' as const, name: 'Twitch' },
  github: { id: 'GITHUB_CLIENT_ID' as const, secret: 'GITHUB_CLIENT_SECRET' as const, name: 'GitHub' },
  x: { id: 'X_CLIENT_ID' as const, secret: 'X_CLIENT_SECRET' as const, name: 'X' },
} satisfies Record<Exclude<OAuthProvider, 'google'>, { id: keyof IdpEnv; secret: keyof IdpEnv; name: string }>;

/** プロバイダー認証の解決結果 */
type ProviderResolution =
  | { ok: true; sub: string; upsert: (db: D1Database, id: string) => Promise<User> }
  | { ok: false; response: Response };


/**
 * redirect_to が許可されたオリジンかどうかを検証する。
 *
 * 許可条件（いずれかを満たせばOK）:
 * 1. IDP_ORIGIN のホスト名から第1ラベルを除いた「親ドメイン」（例: id.0g0.xyz → 0g0.xyz）配下の
 *    サブドメイン、または親ドメイン自身（例: *.0g0.xyz, 0g0.xyz）
 * 2. EXTRA_BFF_ORIGINS（カンマ区切り）に一致するオリジン
 *
 * ❌ http:// は拒否（HTTPS必須）
 */
/**
 * EXTRA_BFF_ORIGINS（カンマ区切り文字列）をパースし、
 * redirectUrl のオリジンがそのいずれかと一致するか確認する。
 */
function matchesExtraBffOrigins(redirectUrl: URL, extraBffOrigins?: string): boolean {
  if (!extraBffOrigins) return false;
  return extraBffOrigins
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .some((extra) => {
      try {
        return redirectUrl.origin === new URL(extra).origin;
      } catch {
        return false;
      }
    });
}

export function isAllowedRedirectTo(
  redirectTo: string,
  idpOrigin: string,
  extraBffOrigins?: string
): boolean {
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirectTo);
  } catch {
    return false;
  }

  // HTTPS のみ許可
  if (redirectUrl.protocol !== 'https:') return false;

  // IDP_ORIGIN から親ドメインを導出して *.parentDomain を許可
  try {
    const idpUrl = new URL(idpOrigin);
    const idpHostname = idpUrl.hostname;

    // IPアドレス（IPv4 / IPv6）の場合は親ドメイン導出をスキップ
    // 例: 127.0.0.1 → '0.0.1' のような不正なドメインマッチを防ぐ
    // 開発環境でIPを使う場合は EXTRA_BFF_ORIGINS を使用すること
    const isIp =
      /^\d+\.\d+\.\d+\.\d+$/.test(idpHostname) || // IPv4
      (idpHostname.startsWith('[') && idpHostname.endsWith(']')); // IPv6 (URL仕様上 [] で囲まれる)

    if (!isIp) {
      const parts = idpHostname.split('.');
      // ラベルが3つ以上 (e.g. id.0g0.xyz) なら第1ラベルを除いた親ドメインを使用
      // ラベルが2つ以下 (e.g. 0g0.xyz) ならそのまま使用
      const parentDomain = parts.length > 2 ? parts.slice(1).join('.') : parts.join('.');
      const host = redirectUrl.hostname;
      if (host === parentDomain || host.endsWith('.' + parentDomain)) {
        return true;
      }
    }
  } catch {
    // ignore — fallthrough to EXTRA_BFF_ORIGINS
  }

  // EXTRA_BFF_ORIGINS による追加オリジン（外部ドメイン向け）
  return matchesExtraBffOrigins(redirectUrl, extraBffOrigins);
}

/**
 * redirect_to が既知のBFFオリジン（USER_ORIGIN / ADMIN_ORIGIN / EXTRA_BFF_ORIGINS）と
 * 完全一致するかを検証する。
 * isAllowedRedirectTo と異なり、*.0g0.xyz のようなワイルドカードマッチは行わない。
 */
export function isBffOrigin(
  redirectTo: string,
  userOrigin: string,
  adminOrigin: string,
  extraBffOrigins?: string
): boolean {
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirectTo);
  } catch {
    return false;
  }

  // HTTPS のみ許可
  if (redirectUrl.protocol !== 'https:') return false;

  // USER_ORIGIN / ADMIN_ORIGIN と origin 単位で完全一致比較
  const bffOrigins = [userOrigin, adminOrigin];
  if (bffOrigins.some((o) => {
    try {
      return redirectUrl.origin === new URL(o).origin;
    } catch {
      return false;
    }
  })) {
    return true;
  }

  // EXTRA_BFF_ORIGINS による追加オリジン（外部ドメイン向け）
  return matchesExtraBffOrigins(redirectUrl, extraBffOrigins);
}

function setSecureCookie(

  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
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

function oauthError(
  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
  message: string,
  code: string = 'OAUTH_ERROR'
): ProviderResolution {
  return { ok: false, response: c.json({ error: { code, message } }, 400) };
}

// ─── プロバイダー固有の認証解決関数 ──────────────────────────────────────────

async function resolveGoogleProvider(
  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
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
  } catch (err) {
    authLogger.error('[oauth-google] Failed to exchange code', err);
    return oauthError(c, 'Failed to exchange code');
  }

  let userInfo;
  try {
    userInfo = await fetchGoogleUserInfo(googleTokens.access_token);
  } catch (err) {
    authLogger.error('[oauth-google] Failed to fetch user info', err);
    return oauthError(c, 'Failed to fetch user info');
  }

  if (!userInfo.email_verified) {
    return oauthError(c, 'Email not verified', 'UNVERIFIED_EMAIL');
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
  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
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
  } catch (err) {
    authLogger.error('[oauth-line] Failed to exchange code', err);
    return oauthError(c, 'Failed to exchange LINE code');
  }

  let userInfo;
  try {
    userInfo = await fetchLineUserInfo(lineTokens.access_token);
  } catch (err) {
    authLogger.error('[oauth-line] Failed to fetch user info', err);
    return oauthError(c, 'Failed to fetch LINE user info');
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
  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
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
  } catch (err) {
    authLogger.error('[oauth-twitch] Failed to exchange code', err);
    return oauthError(c, 'Failed to exchange Twitch code');
  }

  let userInfo;
  try {
    userInfo = await fetchTwitchUserInfo(twitchTokens.access_token);
  } catch (err) {
    authLogger.error('[oauth-twitch] Failed to fetch user info', err);
    return oauthError(c, 'Failed to fetch Twitch user info');
  }

  const isPlaceholderEmail = !userInfo.email;
  const email = userInfo.email ?? `twitch_${userInfo.sub}@twitch.placeholder`;

  if (!isPlaceholderEmail && !(userInfo.email_verified ?? false)) {
    return oauthError(c, 'Email not verified', 'UNVERIFIED_EMAIL');
  }

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
  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
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
  } catch (err) {
    authLogger.error('[oauth-github] Failed to exchange code', err);
    return oauthError(c, 'Failed to exchange GitHub code');
  }

  let githubUser;
  try {
    githubUser = await fetchGithubUserInfo(githubTokens.access_token);
  } catch (err) {
    authLogger.error('[oauth-github] Failed to fetch user info', err);
    return oauthError(c, 'Failed to fetch GitHub user info');
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
  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
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
  } catch (err) {
    authLogger.error('[oauth-x] Failed to exchange code', err);
    return oauthError(c, 'Failed to exchange X code');
  }

  let xUser;
  try {
    xUser = await fetchXUserInfo(xTokens.access_token);
  } catch (err) {
    authLogger.error('[oauth-x] Failed to fetch user info', err);
    return oauthError(c, 'Failed to fetch X user info');
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

/** リフレッシュトークンの有効期限（30日）*/
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * アクセストークンとリフレッシュトークンのペアを発行する。
 * /auth/exchange（新規ログイン）と /auth/refresh（トークンローテーション）で共通利用。
 *
 * @param options.serviceId - サービス連携トークンの場合はサービスID、IdP直接セッションはnull
 * @param options.familyId  - 既存ファミリーへの追加（ローテーション）の場合は既存ID、省略で新規UUID
 */
async function issueTokenPair(
  db: D1Database,
  env: IdpEnv,
  user: User,
  options: { serviceId: string | null; clientId?: string; familyId?: string; scope?: string }
): Promise<{ accessToken: string; refreshToken: string }> {
  const { serviceId, clientId, familyId = crypto.randomUUID(), scope } = options;

  const accessToken = await signAccessToken(
    { iss: env.IDP_ORIGIN, sub: user.id, aud: env.IDP_ORIGIN, email: user.email, role: user.role, scope, cid: clientId },
    env.JWT_PRIVATE_KEY,
    env.JWT_PUBLIC_KEY
  );

  const refreshToken = generateToken(32);
  const tokenHash = await sha256(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();

  // サービス連携時はペアワイズsubを事前計算して保存（外部API逆引き用）
  const pairwiseSub = clientId ? await sha256(`${clientId}:${user.id}`) : null;

  await createRefreshToken(db, {
    id: crypto.randomUUID(),
    userId: user.id,
    serviceId,
    tokenHash,
    familyId,
    expiresAt,
    pairwiseSub,
  });

  return { accessToken, refreshToken };
}

// ─── ルートハンドラー ──────────────────────────────────────────────────────────

// GET /auth/login — BFFからのリダイレクト受け取り + プロバイダー認可へリダイレクト
// client_id を指定すると登録済みサービスの redirect URI で検証（OAuth 2.0 Authorization Code フロー）
app.get('/login', authRateLimitMiddleware, async (c) => {
  const redirectTo = c.req.query('redirect_to');
  const bffState = c.req.query('state');
  const providerParam = c.req.query('provider') ?? 'google';
  const clientId = c.req.query('client_id');
  // link_user_id を直接URLパラメータとして受け付けるのはアカウント乗っ取り攻撃に悪用可能なため、
  // サーバー側で発行したワンタイムトークン（link_token）を使用する
  const linkToken = c.req.query('link_token');

  if (!redirectTo || !bffState) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing required parameters' } }, 400);
  }

  // redirect_to パラメータの長さ制限（Cookie内stateData肥大化防止）
  if (redirectTo.length > 2048) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'redirect_to too long' } }, 400);
  }

  // state パラメータの長さ制限（Cookie汚染・過大データ保存防止）
  if (bffState.length > 1024) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'state parameter too long' } }, 400);
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

  // redirect_to の検証
  // client_id 指定あり → 登録済みサービスの redirect URI テーブルで検証（外部サービス OAuth フロー）
  // client_id 指定なし → 同一ベースドメイン / EXTRA_BFF_ORIGINS で検証（BFF フロー）
  let serviceId: string | undefined;
  if (clientId) {
    const service = await findServiceByClientId(c.env.DB, clientId);
    if (!service) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid client_id' } }, 400);
    }
    const valid = await isValidRedirectUri(c.env.DB, service.id, redirectTo);
    if (!valid) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid redirect_to' } }, 400);
    }
    serviceId = service.id;
  } else {
    // client_id なしは BFF オリジン（USER_ORIGIN / ADMIN_ORIGIN / EXTRA_BFF_ORIGINS）のみ許可
    const isBff = isBffOrigin(redirectTo, c.env.USER_ORIGIN, c.env.ADMIN_ORIGIN, c.env.EXTRA_BFF_ORIGINS);
    if (!isBff) {
      // redirect_to が *.0g0.xyz など同一ベースドメインに属していても、
      // client_id なしでの外部サービスフローは拒否する
      const isKnownDomain = isAllowedRedirectTo(redirectTo, c.env.IDP_ORIGIN, c.env.EXTRA_BFF_ORIGINS);
      if (isKnownDomain) {
        return c.json(
          { error: { code: 'BAD_REQUEST', message: 'client_id is required for external services' } },
          400
        );
      }
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid redirect_to' } }, 400);
    }
  }

  // OIDCオプションパラメータ
  const nonce = c.req.query('nonce');
  const codeChallenge = c.req.query('code_challenge');

  // nonce の長さ制限（RFC 7636 に準じて 128 文字まで）
  if (nonce !== undefined && nonce.length > 128) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'nonce too long' } }, 400);
  }
  const codeChallengeMethod = c.req.query('code_challenge_method');
  const scope = c.req.query('scope');

  // code_challenge が指定された場合は S256 のみ許可（OAuth 2.1 / RFC 7636）
  // code_challenge_method が省略された場合も拒否（デフォルトplainとの混同防止）
  if (codeChallenge && codeChallengeMethod !== 'S256') {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Only S256 code_challenge_method is supported' } }, 400);
  }
  if (!codeChallenge && codeChallengeMethod !== undefined) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'code_challenge is required when code_challenge_method is specified' } }, 400);
  }

  // link_token の検証（SNSプロバイダー連携フロー）
  let linkUserId: string | undefined;
  if (linkToken) {
    const tokenHash = await sha256(linkToken);
    const linkCode = await findAndConsumeAuthCode(c.env.DB, tokenHash);
    if (!linkCode || linkCode.redirect_to !== 'link-intent') {
      return c.json({ error: { code: 'INVALID_LINK_TOKEN', message: 'Invalid or expired link token' } }, 400);
    }
    linkUserId = linkCode.user_id;
  }

  // id側のstate/PKCEを生成
  const idState = generateToken(16);
  const idCodeVerifier = generateCodeVerifier();
  const idCodeChallenge = await generateCodeChallenge(idCodeVerifier);

  // BFF情報をstate cookieに結びつけて保存（provider / serviceId も含める）
  const stateData = JSON.stringify({
    idState,
    bffState,
    redirectTo,
    provider,
    ...(linkUserId ? { linkUserId } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(nonce ? { nonce } : {}),
    ...(codeChallenge ? { codeChallenge, codeChallengeMethod: codeChallengeMethod ?? 'S256' } : {}),
    ...(scope ? { scope } : {}),
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
    const safeMessage = OAUTH_ERROR_MAP[error] ?? 'Authentication failed';
    return c.json({ error: { code: 'OAUTH_ERROR', message: safeMessage } }, 400);
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
    serviceId?: string;
    nonce?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    scope?: string;
  };
  try {
    stateData = JSON.parse(decodeURIComponent(atob(stateCookieRaw)));
  } catch (err) {
    authLogger.error('[oauth-callback] Failed to parse state cookie', err);
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid state cookie' } }, 400);
  }

  // state検証（タイミング攻撃対策のため定数時間比較を使用）
  if (!timingSafeEqual(state, stateData.idState)) {
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

  // BANされたユーザーのログインを拒否
  if (user.banned_at !== null) {
    return c.json({ error: { code: 'ACCOUNT_BANNED', message: 'Your account has been suspended' } }, 403);
  }

  // 管理者ブートストラップ（管理者が0人の場合のみ・原子的操作）
  if (c.env.BOOTSTRAP_ADMIN_EMAIL && user.email === c.env.BOOTSTRAP_ADMIN_EMAIL && user.role !== 'admin') {
    try {
      const elevated = await tryBootstrapAdmin(c.env.DB, user.id);
      if (elevated) user.role = 'admin';
    } catch (err) {
      authLogger.error('[bootstrap] Failed to elevate bootstrap admin', err);
    }
  }

  // ログインイベント記録（エラーがあってもログインフローは継続）
  try {
    const ipAddress = getClientIp(c.req.raw);
    // user-agent は任意長の文字列のため 512 文字に切り詰め（ストレージ DoS 防止）
    const userAgent = c.req.header('user-agent')?.slice(0, 512) ?? null;
    const country = c.req.header('cf-ipcountry') ?? null;
    await insertLoginEvent(c.env.DB, {
      userId: user.id,
      provider,
      ipAddress,
      userAgent,
      country,
    });
  } catch (err) {
    authLogger.error('[login-event] Failed to record login event', err);
  }

  // ワンタイム認可コード発行
  const authCode = generateToken(32);
  const codeHash = await sha256(authCode);
  const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();

  await createAuthCode(c.env.DB, {
    id: crypto.randomUUID(),
    userId: user.id,
    serviceId: stateData.serviceId ?? null,
    codeHash,
    redirectTo: stateData.redirectTo,
    expiresAt,
    nonce: stateData.nonce ?? null,
    codeChallenge: stateData.codeChallenge ?? null,
    codeChallengeMethod: stateData.codeChallengeMethod ?? null,
    scope: stateData.scope ?? null,
  });

  // BFFコールバックへリダイレクト
  const callbackUrl = new URL(stateData.redirectTo);
  callbackUrl.searchParams.set('code', authCode);
  callbackUrl.searchParams.set('state', stateData.bffState);

  return c.redirect(callbackUrl.toString());
});

// POST /auth/exchange — ワンタイムコード交換
// BFF（service_id なし）および外部サービス（service_id あり）の両方をサポート
app.post('/exchange', tokenApiRateLimitMiddleware, async (c) => {
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

  // 下流 PKCE 検証（RFC 7636 / OAuth 2.1）
  if (authCode.code_challenge) {
    if (!body.code_verifier) {
      return c.json({ error: { code: 'INVALID_CODE', message: 'code_verifier is required' } }, 400);
    }
    const expectedChallenge = await generateCodeChallenge(body.code_verifier);
    if (!timingSafeEqual(expectedChallenge, authCode.code_challenge)) {
      return c.json({ error: { code: 'INVALID_CODE', message: 'code_verifier mismatch' } }, 400);
    }
  }

  // ユーザー情報取得
  const user = await findUserById(c.env.DB, authCode.user_id);
  if (!user) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  // BANされたユーザーのトークン発行を拒否
  if (user.banned_at !== null) {
    return c.json({ error: { code: 'ACCOUNT_BANNED', message: 'Your account has been suspended' } }, 403);
  }

  // サービスOAuthフロー: service_id が設定されている場合はクライアント認証を要求
  let serviceId: string | null = null;
  let idTokenSub: string = user.id;
  let idTokenAud: string = c.env.IDP_ORIGIN;
  let serviceScope: string | undefined = undefined;

  if (authCode.service_id !== null) {
    // Authorization: Basic <base64(client_id:client_secret)> を検証
    let service: Awaited<ReturnType<typeof authenticateService>>;
    try {
      service = await authenticateService(c.env.DB, c.req.header('Authorization'));
    } catch {
      return c.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
        500
      );
    }
    // service_id の一致確認（認可コードが別サービス向けであれば拒否）
    if (!service || service.id !== authCode.service_id) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid client credentials' } },
        401
      );
    }

    serviceId = service.id;
    // ペアワイズ sub（OIDC Core 1.0 §8.1）: sha256(client_id:user_id)
    idTokenSub = await sha256(`${service.client_id}:${user.id}`);
    idTokenAud = service.client_id;
    // サービストークンのスコープ: 要求スコープとサービスの allowed_scopes を交差検証
    const allowedScopes = parseAllowedScopes(service.allowed_scopes);
    if (authCode.scope) {
      // 要求スコープをサービスの allowed_scopes と openid でフィルタリング
      const requested = authCode.scope.split(' ').filter(Boolean);
      const valid = requested.filter((s) => s === 'openid' || allowedScopes.includes(s));
      serviceScope = valid.length > 0 ? valid.join(' ') : undefined;
    } else {
      serviceScope = ['openid', ...allowedScopes].join(' ');
    }
  }

  // アクセストークン・リフレッシュトークン発行
  const { accessToken, refreshToken: refreshTokenRaw } = await issueTokenPair(c.env.DB, c.env, user, {
    serviceId,
    clientId: authCode.service_id !== null ? idTokenAud : undefined,
    scope: serviceScope,
  });

  // OIDC ID トークン発行（OpenID Connect Core 1.0）
  // openid スコープがある場合（またはBFFフローでスコープ未指定）のみ発行
  const shouldIssueIdToken = !serviceScope || serviceScope.split(' ').includes('openid');
  let idToken: string | undefined;
  if (shouldIssueIdToken) {
    const authTime = Math.floor(Date.now() / 1000);
    idToken = await signIdToken(
      {
        iss: c.env.IDP_ORIGIN,
        sub: idTokenSub,
        aud: idTokenAud,
        email: user.email,
        name: user.name,
        picture: user.picture,
        authTime,
        nonce: authCode.nonce ?? undefined,
      },
      c.env.JWT_PRIVATE_KEY,
      c.env.JWT_PUBLIC_KEY
    );
  }

  return c.json({
    data: {
      access_token: accessToken,
      ...(idToken ? { id_token: idToken } : {}),
      refresh_token: refreshTokenRaw,
      token_type: 'Bearer',
      expires_in: 900, // 15分
      user: {
        id: idTokenSub,
        email: user.email,
        name: user.name,
        picture: user.picture,
        ...(serviceId === null ? { role: user.role } : {}),
      },
    },
  });
});

// POST /auth/refresh — トークンリフレッシュ（BFFサーバー間専用）
app.post('/refresh', tokenApiRateLimitMiddleware, async (c) => {
  const result = await parseJsonBody(c, RefreshSchema);
  if (!result.ok) return result.response;

  const tokenHash = await sha256(result.data.refresh_token);

  // アトミックに失効させる（TOCTOU競合状態防止: RFC 6819 §5.2.2.3）
  const storedToken = await findAndRevokeRefreshToken(c.env.DB, tokenHash, 'rotation');

  if (!storedToken) {
    // null の場合: 存在しないか既に失効済み → reuse detection チェック
    const existingToken = await findRefreshTokenByHash(c.env.DB, tokenHash);
    if (existingToken) {
      // 既に失効済み → family全失効（リプレイ攻撃検知）
      await revokeTokenFamily(c.env.DB, existingToken.family_id, 'reuse_detected');
      return c.json({ error: { code: 'TOKEN_REUSE', message: 'Token reuse detected' } }, 401);
    }
    return c.json({ error: { code: 'INVALID_TOKEN', message: 'Token not found' } }, 401);
  }

  // 有効期限チェック（既にrotationとして失効済みなので再revokeは不要）
  if (new Date(storedToken.expires_at) < new Date()) {
    return c.json({ error: { code: 'TOKEN_EXPIRED', message: 'Refresh token expired' } }, 401);
  }

  // ユーザー情報取得
  const user = await findUserById(c.env.DB, storedToken.user_id);
  if (!user) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  // BANされたユーザーのトークン更新を拒否
  if (user.banned_at !== null) {
    return c.json({ error: { code: 'ACCOUNT_BANNED', message: 'Your account has been suspended' } }, 403);
  }

  // サービストークンの場合: 元のサービスのスコープを引き継ぐ
  let refreshScope: string | undefined = undefined;
  let refreshService: Awaited<ReturnType<typeof findServiceById>> | undefined = undefined;
  if (storedToken.service_id !== null) {
    refreshService = await findServiceById(c.env.DB, storedToken.service_id);
    if (!refreshService) {
      // サービス削除済み → トークンリフレッシュを拒否
      return c.json({ error: { code: 'INVALID_TOKEN', message: 'Service no longer exists' } }, 401);
    }
    const allowedScopes = parseAllowedScopes(refreshService.allowed_scopes);
    refreshScope = ['openid', ...allowedScopes].join(' ');
  }

  // 新アクセストークン・リフレッシュトークン発行（ローテーション、同じfamily_id）
  // issueTokenPair失敗時は旧トークンの失効を取り消してセッション消失を防止
  let accessToken: string;
  let newRefreshTokenRaw: string;
  try {
    const tokens = await issueTokenPair(c.env.DB, c.env, user, {
      serviceId: storedToken.service_id,
      clientId: refreshService?.client_id,
      familyId: storedToken.family_id,
      scope: refreshScope,
    });
    accessToken = tokens.accessToken;
    newRefreshTokenRaw = tokens.refreshToken;
  } catch (e) {
    await unrevokeRefreshToken(c.env.DB, storedToken.id);
    throw e;
  }

  return c.json({
    data: {
      access_token: accessToken,
      refresh_token: newRefreshTokenRaw,
      token_type: 'Bearer',
      expires_in: 900,
    },
  });
});

// POST /auth/link-intent — SNSプロバイダー連携用ワンタイムトークン発行（認証済みユーザー専用）
// link_user_id をURLパラメータとして直接受け付けると第三者が任意ユーザーのIDを指定し
// アカウント乗っ取りが可能なため、アクセストークンで認証したうえでワンタイムトークンを発行する
app.post('/link-intent', tokenApiRateLimitMiddleware, authMiddleware, async (c) => {
  const tokenUser = c.get('user');

  const linkToken = generateToken(32);
  const tokenHash = await sha256(linkToken);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5分

  await createAuthCode(c.env.DB, {
    id: crypto.randomUUID(),
    userId: tokenUser.sub,
    codeHash: tokenHash,
    redirectTo: 'link-intent', // 連携用の特別な値（通常のコード交換フローと区別する）
    expiresAt,
  });

  return c.json({ data: { link_token: linkToken } });
});

// POST /auth/logout — ログアウト（BFFサーバー間専用）
app.post('/logout', tokenApiRateLimitMiddleware, async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  const parsed = LogoutSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid request body' } }, 400);
  }

  const { refresh_token: refreshToken } = parsed.data;
  if (refreshToken) {
    const tokenHash = await sha256(refreshToken);
    const storedToken = await findRefreshTokenByHash(c.env.DB, tokenHash);
    if (storedToken && storedToken.revoked_at === null) {
      await revokeRefreshToken(c.env.DB, storedToken.id, 'user_logout');
    }
  }

  return c.json({ data: { success: true } });
});

export default app;
