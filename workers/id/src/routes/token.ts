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
  findServiceById,
  findAndRevokeRefreshToken,
  unrevokeRefreshToken,
  revokeTokenFamily,
  generateCodeChallenge,
  signIdToken,
  timingSafeEqual,
  matchRedirectUri,
  normalizeRedirectUri,
} from '@0g0-id/shared';
import type { IdpEnv, User } from '@0g0-id/shared';
import { externalApiRateLimitMiddleware, tokenApiRateLimitMiddleware } from '../middleware/rate-limit';
import { authenticateService } from '../utils/service-auth';
import { parseAllowedScopes, resolveEffectiveScope } from '../utils/scopes';
import { handleDeviceCodeGrant } from './device';
import { issueTokenPair, buildTokenResponse } from '../utils/token-pair';

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
): Promise<{ ok: true; service: NonNullable<Awaited<ReturnType<typeof findServiceByClientId>>> } | { ok: false; error: string; status: 400 | 401 }> {
  if (authHeader?.startsWith('Basic ')) {
    // Confidential client: client_secret_basic
    let service: Awaited<ReturnType<typeof authenticateService>>;
    try {
      service = await authenticateService(db, authHeader);
    } catch {
      return { ok: false, error: 'Internal server error', status: 401 };
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
    return { ok: false, error: 'client_id is required', status: 400 };
  }
  const service = await findServiceByClientId(db, bodyClientId);
  if (!service) {
    return { ok: false, error: 'invalid_client', status: 401 };
  }
  return { ok: true, service };
}

// POST /api/token — 標準 OAuth 2.0 トークンエンドポイント (RFC 6749)
// MCPクライアント等のネイティブアプリが直接HTTPリクエストで利用する
app.post('/', tokenApiRateLimitMiddleware, async (c) => {
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
    // 別サービス向けのトークン → 元に戻して拒否
    await unrevokeRefreshToken(c.env.DB, storedToken.id);
    return c.json({ error: 'invalid_grant', error_description: 'Token was not issued for this client' }, 400);
  }

  // 有効期限チェック
  if (new Date(storedToken.expires_at) < new Date()) {
    await unrevokeRefreshToken(c.env.DB, storedToken.id);
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
    // レース条件対策
    const currentToken = await findRefreshTokenByHash(c.env.DB, tokenHash);
    if (currentToken && currentToken.revoked_reason === 'reuse_detected') {
      return c.json({ error: 'invalid_grant', error_description: 'Token reuse detected' }, 400);
    }
    await unrevokeRefreshToken(c.env.DB, storedToken.id);
    throw e;
  }

  // レスポンス (RFC 6749 §5.1)
  return c.json(buildTokenResponse(accessToken, newRefreshToken, refreshScope));
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
    // BAN済みユーザーのトークンは無効として扱う
    if (user.banned_at !== null) {
      return c.json({ active: false });
    }

    // 保存済みスコープがあればそれを使用（発行時のスコープを正確に反映）
    // マイグレーション前のトークンはallowed_scopesにフォールバック
    const scopeStr = refreshToken.scope ?? parseAllowedScopes(service.allowed_scopes).join(' ');
    const scopeList = scopeStr.split(' ').filter((s: string) => s !== 'openid' && s !== '');

    // ペアワイズsub: 内部IDを直接公開しないようにsha256(client_id:user_id)を使用
    const sub = await sha256(service.client_id + ':' + refreshToken.user_id);

    const response: Record<string, unknown> = {
      active: true,
      sub,
      exp: Math.floor(new Date(refreshToken.expires_at).getTime() / 1000),
      scope: scopeStr,
    };

    applyUserClaims(response, user, scopeList);

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
    // BAN済みユーザーのトークンは無効として扱う
    if (tokenUser.banned_at !== null) {
      return c.json({ active: false });
    }

    // JWTに埋め込まれた発行時スコープを優先（リフレッシュトークンブランチとの一貫性）
    // マイグレーション前のトークンはallowed_scopesにフォールバック
    const tokenScopeStr = payload.scope ?? parseAllowedScopes(service.allowed_scopes).join(' ');
    const tokenScopes = tokenScopeStr.split(' ').filter((s: string) => s !== 'openid' && s !== '');
    const sub = await sha256(service.client_id + ':' + payload.sub);

    const jwtResponse: Record<string, unknown> = {
      active: true,
      sub,
      exp: payload.exp,
      scope: tokenScopeStr,
      token_type: 'access_token',
    };

    applyUserClaims(jwtResponse, tokenUser, tokenScopes);

    return c.json(jwtResponse);
  } catch (err) {
    // JWT検証失敗（期限切れ・署名不正など）
    tokenLogger.warn('Introspect: JWT verification failed', err);
    return c.json({ active: false });
  }
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

  // リフレッシュトークンの失効処理
  const tokenHash = await sha256(body.token);
  const refreshToken = await findRefreshTokenByHash(c.env.DB, tokenHash);

  // RFC 7009: トークンが存在しない・失効済みでも 200 OK を返す（情報漏洩防止）
  // 自サービスが発行したトークンのみ失効可能
  if (refreshToken && refreshToken.revoked_at === null && refreshToken.service_id === service.id) {
    await revokeRefreshToken(c.env.DB, refreshToken.id, 'service_revoke');
  }

  return new Response(null, { status: 200 });
});

export default app;
