import { Hono } from 'hono';
import type { HonoRequest } from 'hono';
import {
  findRefreshTokenByHash,
  findUserById,
  revokeRefreshToken,
  sha256,
  verifyAccessToken,
  createLogger,
  findAndConsumeAuthCode,
  findServiceByClientId,
  findAndRevokeRefreshToken,
  revokeTokenFamily,
  generateCodeChallenge,
  signIdToken,
  timingSafeEqual,
  matchRedirectUri,
  normalizeRedirectUri,
  addRevokedAccessToken,
  isAccessTokenRevoked,
} from '@0g0-id/shared';
import type { IdpEnv, User } from '@0g0-id/shared';
import { externalApiRateLimitMiddleware, tokenApiClientRateLimitMiddleware, tokenApiRateLimitMiddleware } from '../middleware/rate-limit';
import { authenticateService } from '../utils/service-auth';
import { resolveEffectiveScope } from '../utils/scopes';
import { handleDeviceCodeGrant } from './device';
import { issueTokenPair, buildTokenResponse } from '../utils/token-pair';
import { attemptUnrevokeToken } from '../utils/token-recovery';

const tokenLogger = createLogger('token');

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
  } catch (err) {
    tokenLogger.error('Failed to parse request body', err);
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

/**
 * client_secret_basic 認証（Authorization: Basic）またはパブリッククライアント（none）を処理する。
 * Authorization ヘッダーがある場合は Basic 認証を検証し、クライアントIDの一致も確認する。
 * ヘッダーがない場合はパブリッククライアントとして bodyClientId のみで検証する。
 */
async function resolveOAuthClient(
  db: D1Database,
  authHeader: string | undefined,
  bodyClientId: string | undefined
): Promise<{ ok: true; service: NonNullable<Awaited<ReturnType<typeof findServiceByClientId>>> } | { ok: false; error: string; status: 400 | 401 | 500 }> {
  if (authHeader?.startsWith('Basic ')) {
    // Confidential client: client_secret_basic
    let service: Awaited<ReturnType<typeof authenticateService>>;
    try {
      service = await authenticateService(db, authHeader);
    } catch {
      return { ok: false, error: 'server_error', status: 500 };
    }
    if (!service) {
      return { ok: false, error: 'invalid_client', status: 401 };
    }
    // bodyのclient_idが指定されている場合、Basicヘッダーのclient_idと一致するか確認
    if (bodyClientId && bodyClientId !== service.client_id) {
      return { ok: false, error: 'invalid_client', status: 401 };
    }
    return { ok: true, service };
  }

  // Public client: client_id のみで識別（client_secret なし）
  if (!bodyClientId) {
    return { ok: false, error: 'invalid_request', status: 400 };
  }
  const service = await findServiceByClientId(db, bodyClientId);
  if (!service) {
    return { ok: false, error: 'invalid_client', status: 401 };
  }
  return { ok: true, service };
}

// POST /api/token — 標準 OAuth 2.0 トークンエンドポイント (RFC 6749)
// MCPクライアント等のネイティブアプリが直接HTTPリクエストで利用する
app.post('/', tokenApiRateLimitMiddleware, tokenApiClientRateLimitMiddleware, async (c) => {
  // application/x-www-form-urlencoded をパース
  const contentType = c.req.header('Content-Type') ?? '';
  let params: Record<string, string>;
  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const body = await c.req.parseBody();
      params = {};
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string') {
          params[key] = value;
        }
      }
    } else if (contentType.includes('application/json')) {
      params = await c.req.json<Record<string, string>>();
    } else {
      return c.json({ error: 'invalid_request', error_description: 'Unsupported Content-Type' }, 400);
    }
  } catch {
    return c.json({ error: 'invalid_request', error_description: 'Failed to parse request body' }, 400);
  }

  const grantType = params['grant_type'];

  if (grantType === 'authorization_code') {
    return handleAuthorizationCodeGrant(c, params);
  } else if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(c, params);
  } else if (grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
    return handleDeviceCodeGrant(c, params);
  } else {
    return c.json({ error: 'unsupported_grant_type', error_description: 'Unsupported grant_type' }, 400);
  }
});

/**
 * authorization_code グラント処理
 */
async function handleAuthorizationCodeGrant(
  c: { env: IdpEnv; req: { header: (name: string) => string | undefined }; json: (data: unknown, status?: number) => Response },
  params: Record<string, string>
): Promise<Response> {
  const code = params['code'];
  const redirectUri = params['redirect_uri'];
  const clientId = params['client_id'];
  const codeVerifier = params['code_verifier'];

  if (!code) {
    return c.json({ error: 'invalid_request', error_description: 'code is required' }, 400);
  }
  if (!redirectUri) {
    return c.json({ error: 'invalid_request', error_description: 'redirect_uri is required' }, 400);
  }
  if (!codeVerifier) {
    return c.json({ error: 'invalid_request', error_description: 'code_verifier is required' }, 400);
  }

  // クライアント認証
  const clientResult = await resolveOAuthClient(c.env.DB, c.req.header('Authorization'), clientId);
  if (!clientResult.ok) {
    return c.json({ error: clientResult.error }, clientResult.status);
  }
  const service = clientResult.service;

  // 認可コード検証
  const codeHash = await sha256(code);
  const authCode = await findAndConsumeAuthCode(c.env.DB, codeHash);
  if (!authCode) {
    return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }, 400);
  }

  // service_id の一致確認
  if (authCode.service_id !== service.id) {
    return c.json({ error: 'invalid_grant', error_description: 'Authorization code was not issued for this client' }, 400);
  }

  // redirect_uri を正規化してから比較（RFC 6749 §4.1.3）
  const normalizedRedirectUri = normalizeRedirectUri(redirectUri);
  if (!normalizedRedirectUri || !matchRedirectUri(authCode.redirect_to, normalizedRedirectUri)) {
    return c.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
  }

  // パブリッククライアント判定（Authorizationヘッダーがない = パブリッククライアント）
  const isPublicClient = !c.req.header('Authorization')?.startsWith('Basic ');

  // パブリッククライアントはPKCEを必須とする（RFC 7636 §4.4 / OAuth 2.1）
  if (isPublicClient && !authCode.code_challenge) {
    return c.json({ error: 'invalid_grant', error_description: 'PKCE is required for public clients' }, 400);
  }

  // PKCE 検証 (S256)
  if (authCode.code_challenge) {
    const expectedChallenge = await generateCodeChallenge(codeVerifier);
    if (!timingSafeEqual(expectedChallenge, authCode.code_challenge)) {
      return c.json({ error: 'invalid_grant', error_description: 'code_verifier mismatch' }, 400);
    }
  }

  // ユーザー情報取得
  const user = await findUserById(c.env.DB, authCode.user_id);
  if (!user) {
    return c.json({ error: 'invalid_grant', error_description: 'User not found' }, 400);
  }
  if (user.banned_at !== null) {
    return c.json({ error: 'access_denied', error_description: 'Account has been suspended' }, 403);
  }

  // スコープ計算
  const serviceScope = resolveEffectiveScope(authCode.scope, service.allowed_scopes);

  // トークン発行
  const { accessToken, refreshToken } = await issueTokenPair(c.env.DB, c.env, user, {
    serviceId: service.id,
    clientId: service.client_id,
    scope: serviceScope,
  });

  // OIDC ID トークン発行（openid スコープがある場合）
  let idToken: string | undefined;
  if (serviceScope?.split(' ').includes('openid')) {
    const pairwiseSub = await sha256(`${service.client_id}:${user.id}`);
    const authTime = Math.floor(Date.now() / 1000);
    idToken = await signIdToken(
      {
        iss: c.env.IDP_ORIGIN,
        sub: pairwiseSub,
        aud: service.client_id,
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

  // レスポンス (RFC 6749 §5.1)
  return c.json(buildTokenResponse(accessToken, refreshToken, serviceScope, idToken));
}

/**
 * refresh_token グラント処理
 */
async function handleRefreshTokenGrant(
  c: { env: IdpEnv; req: { header: (name: string) => string | undefined }; json: (data: unknown, status?: number) => Response },
  params: Record<string, string>
): Promise<Response> {
  const refreshTokenRaw = params['refresh_token'];
  const clientId = params['client_id'];

  if (!refreshTokenRaw) {
    return c.json({ error: 'invalid_request', error_description: 'refresh_token is required' }, 400);
  }

  // クライアント認証
  const clientResult = await resolveOAuthClient(c.env.DB, c.req.header('Authorization'), clientId);
  if (!clientResult.ok) {
    return c.json({ error: clientResult.error }, clientResult.status);
  }
  const service = clientResult.service;

  const tokenHash = await sha256(refreshTokenRaw);

  // アトミックに失効させる（TOCTOU競合状態防止: RFC 6819 §5.2.2.3）
  const storedToken = await findAndRevokeRefreshToken(c.env.DB, tokenHash, 'rotation');

  if (!storedToken) {
    // reuse detection チェック
    const existingToken = await findRefreshTokenByHash(c.env.DB, tokenHash);
    if (existingToken) {
      if (existingToken.revoked_reason === 'rotation') {
        await revokeTokenFamily(c.env.DB, existingToken.family_id, 'reuse_detected');
        return c.json({ error: 'invalid_grant', error_description: 'Token reuse detected' }, 400);
      }
      return c.json({ error: 'invalid_grant', error_description: 'Token has been revoked' }, 400);
    }
    return c.json({ error: 'invalid_grant', error_description: 'Invalid refresh token' }, 400);
  }

  // サービス所有権確認
  if (storedToken.service_id !== service.id) {
    // 並行リクエストが reuse_detected を発動した可能性をチェック（レース条件対策）
    const currentToken = await findRefreshTokenByHash(c.env.DB, tokenHash);
    if (currentToken && currentToken.revoked_reason === 'reuse_detected') {
      return c.json({ error: 'invalid_grant', error_description: 'Token reuse detected' }, 400);
    }
    // 別サービス向けのトークン → 元に戻して拒否
    await attemptUnrevokeToken(c.env.DB, storedToken.id, '[token] service_id mismatch 後');
    return c.json({ error: 'invalid_grant', error_description: 'Token was not issued for this client' }, 400);
  }

  // 有効期限チェック
  if (new Date(storedToken.expires_at) < new Date()) {
    // 並行リクエストが reuse_detected を発動した可能性をチェック（レース条件対策）
    const currentToken = await findRefreshTokenByHash(c.env.DB, tokenHash);
    if (currentToken && currentToken.revoked_reason === 'reuse_detected') {
      return c.json({ error: 'invalid_grant', error_description: 'Token reuse detected' }, 400);
    }
    return c.json({ error: 'invalid_grant', error_description: 'Refresh token expired' }, 400);
  }

  // ユーザー情報取得
  const user = await findUserById(c.env.DB, storedToken.user_id);
  if (!user) {
    return c.json({ error: 'invalid_grant', error_description: 'User not found' }, 400);
  }
  if (user.banned_at !== null) {
    return c.json({ error: 'access_denied', error_description: 'Account has been suspended' }, 403);
  }

  // スコープ引き継ぎ
  const refreshScope = storedToken.scope ?? resolveEffectiveScope(null, service.allowed_scopes);

  // 新トークン発行（ローテーション）
  let accessToken: string;
  let newRefreshToken: string;
  try {
    const tokens = await issueTokenPair(c.env.DB, c.env, user, {
      serviceId: service.id,
      clientId: service.client_id,
      familyId: storedToken.family_id,
      scope: refreshScope,
    });
    accessToken = tokens.accessToken;
    newRefreshToken = tokens.refreshToken;
  } catch (e) {
    tokenLogger.error('handleRefreshTokenGrant: issueTokenPair failed', e);
    // レース条件対策
    const currentToken = await findRefreshTokenByHash(c.env.DB, tokenHash);
    if (currentToken && currentToken.revoked_reason === 'reuse_detected') {
      return c.json({ error: 'invalid_grant', error_description: 'Token reuse detected' }, 400);
    }
    await attemptUnrevokeToken(c.env.DB, storedToken.id, '[token] issueTokenPair failure 後');
    return c.json({ error: 'server_error', error_description: 'Token operation failed' }, 500);
  }

  // レスポンス (RFC 6749 §5.1)
  return c.json(buildTokenResponse(accessToken, newRefreshToken, refreshScope));
}

// イントロスペクション: リフレッシュトークンの検証ヘルパー（RFC 7662）
// 見つかった場合はレスポンスオブジェクト（active:false含む）を返し、見つからない・失効済みの場合はnullを返す
async function introspectRefreshToken(
  db: D1Database,
  service: NonNullable<Awaited<ReturnType<typeof authenticateService>>>,
  tokenHash: string,
  issuer: string
): Promise<Record<string, unknown> | null> {
  const refreshToken = await findRefreshTokenByHash(db, tokenHash);
  if (!refreshToken) return null;
  if (refreshToken.revoked_at !== null) return { active: false };
  if (refreshToken.service_id !== service.id) {
    return { active: false };
  }
  if (new Date(refreshToken.expires_at) < new Date()) {
    return { active: false };
  }
  const user = await findUserById(db, refreshToken.user_id);
  if (!user || user.banned_at !== null) {
    return { active: false };
  }
  const scopeStr = refreshToken.scope ?? '';
  const scopeList = scopeStr.split(' ').filter((s: string) => s !== 'openid' && s !== '');
  const sub = await sha256(service.client_id + ':' + refreshToken.user_id);
  const response: Record<string, unknown> = {
    active: true,
    iss: issuer,
    token_type: 'refresh_token',
    sub,
    exp: Math.floor(new Date(refreshToken.expires_at).getTime() / 1000),
    iat: Math.floor(new Date(refreshToken.created_at).getTime() / 1000),
    scope: scopeStr,
  };
  applyUserClaims(response, user, scopeList);
  return response;
}

// イントロスペクション: JWTアクセストークンの検証ヘルパー（RFC 7662）
// 検証成功時はレスポンスオブジェクトを返し、JWT検証失敗時はnullを返す
async function introspectJwtToken(
  db: D1Database,
  service: NonNullable<Awaited<ReturnType<typeof authenticateService>>>,
  token: string,
  env: IdpEnv
): Promise<Record<string, unknown> | null> {
  let payload: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    payload = await verifyAccessToken(token, env.JWT_PUBLIC_KEY, env.IDP_ORIGIN, env.IDP_ORIGIN);
  } catch (err) {
    tokenLogger.warn('Introspect: JWT verification failed', err);
    return null;
  }
  // RFC 7009: jtiがブロックリストに存在する場合は失効済み
  if (payload.jti && await isAccessTokenRevoked(db, payload.jti)) {
    return { active: false };
  }
  // BFFセッショントークン（cid未設定）は外部サービスからイントロスペクト不可
  if (!payload.cid || payload.cid !== service.client_id) {
    return { active: false };
  }
  const tokenUser = await findUserById(db, payload.sub);
  if (!tokenUser || tokenUser.banned_at !== null) {
    return { active: false };
  }
  // JWTに埋め込まれた発行時スコープを優先（リフレッシュトークンブランチとの一貫性）
  // スコープ未設定の旧トークンは空文字列（RFC 7662 §2.2 - 実際に付与されたスコープのみ返す）
  const tokenScopeStr = payload.scope ?? '';
  const tokenScopes = tokenScopeStr.split(' ').filter((s: string) => s !== 'openid' && s !== '');
  const sub = await sha256(service.client_id + ':' + payload.sub);
  const jwtResponse: Record<string, unknown> = {
    active: true,
    iss: payload.iss,
    sub,
    exp: payload.exp,
    iat: payload.iat,
    scope: tokenScopeStr,
    token_type: 'access_token',
  };
  applyUserClaims(jwtResponse, tokenUser, tokenScopes);
  return jwtResponse;
}

// POST /api/token/introspect — RFC 7662 トークンイントロスペクション
app.post('/introspect', externalApiRateLimitMiddleware, async (c) => {
  // Basic認証でサービス認証
  let service: Awaited<ReturnType<typeof authenticateService>>;
  try {
    service = await authenticateService(c.env.DB, c.req.header('Authorization'));
  } catch (err) {
    tokenLogger.error('Introspect: service authentication failed', err);
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

  const token = body.token;
  const tokenHash = await sha256(token);

  // token_type_hint に従って検索順を最適化（RFC 7662 §2.1 推奨）
  // 'access_token' ヒントならJWT→リフレッシュトークンの順、それ以外はリフレッシュトークン→JWTの順
  let result: Record<string, unknown> | null;
  if (body.token_type_hint === 'access_token') {
    result = await introspectJwtToken(c.env.DB, service!, token, c.env);
    if (result === null) {
      result = await introspectRefreshToken(c.env.DB, service!, tokenHash, c.env.IDP_ORIGIN);
    }
  } else {
    result = await introspectRefreshToken(c.env.DB, service!, tokenHash, c.env.IDP_ORIGIN);
    if (result === null) {
      result = await introspectJwtToken(c.env.DB, service!, token, c.env);
    }
  }

  return c.json(result ?? { active: false });
});

// POST /api/token/revoke — RFC 7009 トークン失効
app.post('/revoke', externalApiRateLimitMiddleware, async (c) => {
  // Basic認証でサービス認証
  let service: Awaited<ReturnType<typeof authenticateService>>;
  try {
    service = await authenticateService(c.env.DB, c.req.header('Authorization'));
  } catch (err) {
    tokenLogger.error('Revoke: service authentication failed', err);
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

  const token = body.token;

  // JWTアクセストークンの失効処理（RFC 7009 §2.1）
  // JWTは header.payload.signature の3セクション形式（Base64url）で識別する
  const JWT_PATTERN = /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/;
  if (JWT_PATTERN.test(token)) {
    try {
      const payload = await verifyAccessToken(token, c.env.JWT_PUBLIC_KEY, c.env.IDP_ORIGIN, c.env.IDP_ORIGIN);
      // 自サービスが発行したトークンかつ有効期限内のものだけブロックリストに追加
      if (payload.jti && payload.cid === service.client_id && payload.exp && payload.exp > Math.floor(Date.now() / 1000)) {
        await addRevokedAccessToken(c.env.DB, payload.jti, payload.exp);
      }
    } catch {
      // JWT検証失敗 → RFC 7009: エラーを無視して 200 OK を返す
    }
    return new Response(null, { status: 200 });
  }

  // リフレッシュトークンの失効処理
  const tokenHash = await sha256(token);
  const refreshToken = await findRefreshTokenByHash(c.env.DB, tokenHash);

  // RFC 7009: トークンが存在しない・失効済みでも 200 OK を返す（情報漏洩防止）
  // 自サービスが発行したトークンのみ失効可能
  if (refreshToken && refreshToken.revoked_at === null && refreshToken.service_id === service.id) {
    await revokeRefreshToken(c.env.DB, refreshToken.id, 'service_revoke');
  }

  return new Response(null, { status: 200 });
});

export default app;
