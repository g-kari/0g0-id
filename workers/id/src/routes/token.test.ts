import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// @0g0-id/sharedの全関数をモック
vi.mock('@0g0-id/shared', () => ({
  createLogger: vi.fn().mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  findRefreshTokenByHash: vi.fn(),
  findServiceByClientId: vi.fn(),
  findServiceById: vi.fn(),
  findUserById: vi.fn(),
  revokeRefreshToken: vi.fn(),
  sha256: vi.fn(),
  timingSafeEqual: vi.fn(),
  verifyAccessToken: vi.fn(),
  // POST /api/token/ grant types で使用
  findAndConsumeAuthCode: vi.fn(),
  findAndRevokeRefreshToken: vi.fn(),
  unrevokeRefreshToken: vi.fn(),
  revokeTokenFamily: vi.fn(),
  generateCodeChallenge: vi.fn(),
  signIdToken: vi.fn(),
  matchRedirectUri: vi.fn(),
  normalizeRedirectUri: vi.fn(),
  signAccessToken: vi.fn(),
  generateToken: vi.fn(),
  createRefreshToken: vi.fn(),
  // JTIブロックリスト
  addRevokedAccessToken: vi.fn(),
  isAccessTokenRevoked: vi.fn(),
  // HMAC-SHA256署名付きCookie（auth.ts経由の間接利用対策）
  signCookie: vi.fn(),
  verifyCookie: vi.fn(),
  // token-recovery.ts 経由で使用
  findRefreshTokenById: vi.fn(),
}));

import {
  findRefreshTokenByHash,
  findServiceByClientId,
  findServiceById,
  findUserById,
  revokeRefreshToken,
  sha256,
  timingSafeEqual,
  verifyAccessToken,
  findAndConsumeAuthCode,
  findAndRevokeRefreshToken,
  unrevokeRefreshToken,
  revokeTokenFamily,
  generateCodeChallenge,
  signIdToken,
  matchRedirectUri,
  normalizeRedirectUri,
  signAccessToken,
  generateToken,
  createRefreshToken,
  addRevokedAccessToken,
  isAccessTokenRevoked,
  findRefreshTokenById,
} from '@0g0-id/shared';

import tokenRoutes from './token';

const baseUrl = 'https://id.0g0.xyz';

const mockEnv = {
  DB: {} as D1Database,
  IDP_ORIGIN: 'https://id.0g0.xyz',
  JWT_PRIVATE_KEY: 'mock-private-key',
  JWT_PUBLIC_KEY: 'mock-public-key',
};

const mockService = {
  id: 'service-1',
  name: 'Test Service',
  client_id: 'test-client-id',
  client_secret_hash: 'hashed-secret',
  allowed_scopes: JSON.stringify(['profile', 'email']),
  owner_user_id: 'admin-user-id',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const mockUser = {
  id: 'user-1',
  google_sub: 'google-sub-1',
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: 'test@example.com',
  email_verified: 1,
  name: 'Test User',
  picture: 'https://example.com/pic.jpg',
  phone: '090-0000-0000',
  address: 'Tokyo',
  role: 'user' as const,
  banned_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const mockRefreshToken = {
  id: 'rt-id',
  user_id: 'user-1',
  service_id: 'service-1',
  token_hash: 'hashed-token',
  family_id: 'family-1',
  revoked_at: null,
  revoked_reason: null,
  scope: 'profile email',
  expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  created_at: '2024-01-01T00:00:00Z',
};

const mockAuthCode = {
  id: 'code-id',
  user_id: 'user-1',
  service_id: 'service-1',
  code_hash: 'hashed-code',
  redirect_to: 'http://localhost:51234/callback',
  code_challenge: 'expected-challenge',
  scope: 'openid profile email',
  nonce: null,
  expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  used_at: null,
  created_at: '2024-01-01T00:00:00Z',
};

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route('/api/token', tokenRoutes);
  return app;
}

// Basic認証ヘッダーを生成
function makeBasicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function sendRequest(
  app: ReturnType<typeof buildApp>,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    formBody?: Record<string, string>;
    authHeader?: string;
  } = {}
) {
  const { method = 'POST', body, formBody, authHeader } = options;
  const headers: Record<string, string> = {};
  if (authHeader) headers['Authorization'] = authHeader;

  let bodyToSend: string | undefined;
  if (formBody) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    bodyToSend = new URLSearchParams(formBody).toString();
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    bodyToSend = JSON.stringify(body);
  }

  return app.request(
    new Request(`${baseUrl}${path}`, {
      method,
      headers,
      body: bodyToSend,
    }),
    undefined,
    mockEnv as unknown as Record<string, string>
  );
}

// ===== POST /api/token/introspect =====
describe('POST /api/token/introspect', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue('hashed-token');
    vi.mocked(findServiceByClientId).mockResolvedValue(mockService as never);
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken as never);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    // デフォルトはJWT検証失敗（リフレッシュトークンが見つかった場合はJWT検証は呼ばれない）
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error('not a JWT'));
  });

  it('Authorizationヘッダーなし → { active: false } + 401 + WWW-Authenticate: Basic', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'some-token' },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="0g0-id"');
  });

  it('Basicでないauth形式 → { active: false } + 401', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'some-token' },
      authHeader: 'Bearer some-token',
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('不正なBase64エンコード → { active: false } + 401', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'some-token' },
      authHeader: 'Basic !!!invalid!!!',
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('コロンなしのクレデンシャル → { active: false } + 401', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'some-token' },
      authHeader: `Basic ${btoa('nocredshere')}`,
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('存在しないサービス → { active: false } + 401', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'some-token' },
      authHeader: makeBasicAuth('unknown-client', 'secret'),
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('シークレット不一致 → { active: false } + 401', async () => {
    vi.mocked(timingSafeEqual).mockReturnValue(false);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'some-token' },
      authHeader: makeBasicAuth('test-client-id', 'wrong-secret'),
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('JSONボディが不正 → { active: false } + 400', async () => {
    const res = await buildApp().request(
      new Request(`${baseUrl}/api/token/introspect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: makeBasicAuth('test-client-id', 'secret'),
        },
        body: 'not-json',
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('tokenが未指定 → { active: false } + 400', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      body: {},
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('失効済みトークン → { active: false }', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: '2024-01-01T00:00:00Z',
    } as never);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'revoked-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('他サービスのトークン → { active: false }', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      service_id: 'other-service-id',
    } as never);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'other-service-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('期限切れトークン → { active: false }', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    } as never);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'expired-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('ユーザー不存在 → { active: false }', async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('BAN済みユーザーのリフレッシュトークン → { active: false }', async () => {
    vi.mocked(findUserById).mockResolvedValue({ ...mockUser, banned_at: '2024-01-01T00:00:00Z' });
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('有効なトークン → ユーザー情報を含む { active: true } を返す', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      active: boolean;
      sub: string;
      exp: number;
      scope: string;
      name: string;
      email: string;
    }>();
    expect(body.active).toBe(true);
    expect(body.sub).toBe('hashed-token'); // sha256(client_id:user_id) ペアワイズsub
    expect(body.scope).toBe('profile email');
    expect(body.name).toBe('Test User');
    expect(body.email).toBe('test@example.com');
  });

  it('profileスコープのみ → name/pictureを返すがemailは返さない', async () => {
    // リフレッシュトークンのscopeがintrospectのクレーム決定に使われる（サービスのallowed_scopesではない）
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      scope: 'profile',
    } as never);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.active).toBe(true);
    expect(body.name).toBe('Test User');
    expect(body.email).toBeUndefined();
  });

  it('emailスコープのみ → emailを返すがnameは返さない', async () => {
    // リフレッシュトークンのscopeがintrospectのクレーム決定に使われる（サービスのallowed_scopesではない）
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      scope: 'email',
    } as never);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.active).toBe(true);
    expect(body.email).toBe('test@example.com');
    expect(body.name).toBeUndefined();
  });

  it('トークンが存在しない → { active: false }', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error('invalid token'));
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'nonexistent-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  // ─── JWTアクセストークンのイントロスペクション ───────────────────────────

  const mockJwtPayload = {
    iss: 'https://id.0g0.xyz',
    sub: 'user-1',
    aud: 'https://id.0g0.xyz',
    exp: Math.floor(Date.now() / 1000) + 900,
    iat: Math.floor(Date.now() / 1000),
    jti: 'jti-1',
    kid: 'kid-1',
    email: 'test@example.com',
    role: 'user' as const,
    scope: 'openid profile email',
    cid: 'test-client-id',
  };

  it('有効なJWTアクセストークン → { active: true } とユーザー情報を返す', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    vi.mocked(verifyAccessToken).mockResolvedValue(mockJwtPayload);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-jwt-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.active).toBe(true);
    expect(body.token_type).toBe('access_token');
    expect(body.name).toBe('Test User');
    expect(body.email).toBe('test@example.com');
    expect(body.email_verified).toBe(true);
  });

  it('JWTのcidが異なるサービス → { active: false }（サービス間トークン流用防止）', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    vi.mocked(verifyAccessToken).mockResolvedValue({ ...mockJwtPayload, cid: 'other-client-id' });
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'other-service-jwt' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('cidなしJWT（BFFトークン）→ { active: false }（外部サービスはBFFトークンをイントロスペクト不可）', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    vi.mocked(verifyAccessToken).mockResolvedValue({ ...mockJwtPayload, cid: undefined });
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'bff-session-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('JWT署名検証失敗（期限切れ等）→ { active: false }', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error('JWTExpired'));
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'expired-jwt' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('JTIブロックリストhit → { active: false }（失効済みアクセストークン）', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    vi.mocked(verifyAccessToken).mockResolvedValue(mockJwtPayload);
    vi.mocked(isAccessTokenRevoked).mockResolvedValue(true);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'revoked-jwt', token_type_hint: 'access_token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
    expect(vi.mocked(isAccessTokenRevoked)).toHaveBeenCalledWith(mockEnv.DB, mockJwtPayload.jti);
  });

  it('JWTのユーザーが存在しない → { active: false }', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    vi.mocked(verifyAccessToken).mockResolvedValue(mockJwtPayload);
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-jwt-no-user' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('BAN済みユーザーのJWTアクセストークン → { active: false }', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    vi.mocked(verifyAccessToken).mockResolvedValue(mockJwtPayload);
    vi.mocked(findUserById).mockResolvedValue({ ...mockUser, banned_at: '2024-01-01T00:00:00Z' });
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-jwt-banned-user' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('JWTイントロスペクション: profileスコープのみ → name/pictureを返すがemailは返さない', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue({
      ...mockService,
      allowed_scopes: JSON.stringify(['profile']),
    } as never);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    vi.mocked(verifyAccessToken).mockResolvedValue({ ...mockJwtPayload, scope: 'openid profile' });
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-jwt-profile-only' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.active).toBe(true);
    expect(body.name).toBe('Test User');
    expect(body.email).toBeUndefined();
  });

  it('リフレッシュトークンのscopeがnull → fail-closedでスコープなし（ユーザーデータ非公開）', async () => {
    // introspectRefreshTokenはトークン自身のscopeを使用（サービスのallowed_scopesは不使用）
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      scope: null,
    } as never);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.active).toBe(true);
    expect(body.scope).toBe('');
    expect(body.name).toBeUndefined();
    expect(body.email).toBeUndefined();
  });

  // RFC 7662: application/x-www-form-urlencoded サポート
  it('form-encoded: 有効なトークン → { active: true } を返す', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      formBody: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean; name: string; email: string }>();
    expect(body.active).toBe(true);
    expect(body.name).toBe('Test User');
    expect(body.email).toBe('test@example.com');
  });

  it('form-encoded: tokenが未指定 → { active: false } + 400', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      formBody: {},
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it('form-encoded: token_type_hintを指定しても正常動作 → { active: true }', async () => {
    const res = await sendRequest(app, '/api/token/introspect', {
      formBody: { token: 'valid-token', token_type_hint: 'refresh_token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ active: boolean }>();
    expect(body.active).toBe(true);
  });

  // RFC 7662 §2.1: token_type_hint による検索順最適化
  it('token_type_hint=access_token: JWTを先に検証し { active: true } を返す', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockJwtPayload);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-jwt', token_type_hint: 'access_token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.active).toBe(true);
    expect(body.token_type).toBe('access_token');
    // access_token ヒント時はJWTを先に試みるためDBアクセスなし
    expect(vi.mocked(findRefreshTokenByHash)).not.toHaveBeenCalled();
  });

  it('token_type_hint=access_token: JWT失敗時はリフレッシュトークンにフォールバック → { active: true }', async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error('not a JWT'));
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken as never);
    const res = await sendRequest(app, '/api/token/introspect', {
      body: { token: 'valid-refresh-token', token_type_hint: 'access_token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.active).toBe(true);
    expect(body.token_type).toBe('refresh_token'); // introspectRefreshTokenは token_type: 'refresh_token' を返す
  });
});

// ===== POST /api/token/revoke =====
describe('POST /api/token/revoke', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue('hashed-token');
    vi.mocked(findServiceByClientId).mockResolvedValue(mockService as never);
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken as never);
    vi.mocked(revokeRefreshToken).mockResolvedValue(undefined);
  });

  it('Authorizationヘッダーなし → { error: invalid_client } + 401 + WWW-Authenticate', async () => {
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'some-token' },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_client');
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="0g0-id"');
  });

  it('Basicでないauth形式 → 401', async () => {
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'some-token' },
      authHeader: 'Bearer some-token',
    });
    expect(res.status).toBe(401);
  });

  it('不正なBase64エンコード → 401', async () => {
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'some-token' },
      authHeader: 'Basic !!!invalid!!!',
    });
    expect(res.status).toBe(401);
  });

  it('コロンなしのクレデンシャル → 401', async () => {
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'some-token' },
      authHeader: `Basic ${btoa('nocredshere')}`,
    });
    expect(res.status).toBe(401);
  });

  it('存在しないサービス → 401', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'some-token' },
      authHeader: makeBasicAuth('unknown-client', 'secret'),
    });
    expect(res.status).toBe(401);
  });

  it('シークレット不一致 → 401', async () => {
    vi.mocked(timingSafeEqual).mockReturnValue(false);
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'some-token' },
      authHeader: makeBasicAuth('test-client-id', 'wrong-secret'),
    });
    expect(res.status).toBe(401);
  });

  it('JSONボディが不正 → 400', async () => {
    const res = await buildApp().request(
      new Request(`${baseUrl}/api/token/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: makeBasicAuth('test-client-id', 'secret'),
        },
        body: 'not-json',
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('tokenが未指定 → 400', async () => {
    const res = await sendRequest(app, '/api/token/revoke', {
      body: {},
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('有効なトークン → 200 + revokeRefreshTokenが呼ばれる', async () => {
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(revokeRefreshToken)).toHaveBeenCalledWith(
      mockEnv.DB,
      mockRefreshToken.id,
      'service_revoke'
    );
  });

  it('token_type_hintを指定しても正常動作 → 200', async () => {
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'valid-token', token_type_hint: 'refresh_token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(revokeRefreshToken)).toHaveBeenCalledOnce();
  });

  it('RFC 7009: 存在しないトークン → revokeせずに 200 OK を返す', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'nonexistent-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(revokeRefreshToken)).not.toHaveBeenCalled();
  });

  it('RFC 7009: 失効済みトークン → revokeせずに 200 OK を返す', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: '2024-01-01T00:00:00Z',
    } as never);
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'revoked-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(revokeRefreshToken)).not.toHaveBeenCalled();
  });

  it('RFC 7009: 他サービスのトークン → revokeせずに 200 OK を返す（情報漏洩防止）', async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      service_id: 'other-service-id',
    } as never);
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'other-service-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(revokeRefreshToken)).not.toHaveBeenCalled();
  });

  // RFC 7009: application/x-www-form-urlencoded サポート
  it('form-encoded: 有効なトークン → 200 + revokeRefreshTokenが呼ばれる', async () => {
    const res = await sendRequest(app, '/api/token/revoke', {
      formBody: { token: 'valid-token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(revokeRefreshToken)).toHaveBeenCalledWith(mockEnv.DB, mockRefreshToken.id, 'service_revoke');
  });

  it('form-encoded: token_type_hintを指定しても正常動作 → 200', async () => {
    const res = await sendRequest(app, '/api/token/revoke', {
      formBody: { token: 'valid-token', token_type_hint: 'refresh_token' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(revokeRefreshToken)).toHaveBeenCalledOnce();
  });

  // ─── JWTアクセストークンのrevoke（RFC 7009 §2.1）───────────────────────────

  const mockJwtRevokePayload = {
    iss: 'https://id.0g0.xyz',
    sub: 'user-1',
    aud: 'https://id.0g0.xyz',
    exp: Math.floor(Date.now() / 1000) + 900,
    iat: Math.floor(Date.now() / 1000),
    jti: 'jti-revoke-1',
    kid: 'kid-1',
    scope: 'openid profile email',
    cid: 'test-client-id',
    role: 'user' as const,
    email: 'test@example.com',
  };

  it('JWTアクセストークン（期限内）→ 200 + addRevokedAccessTokenが呼ばれる', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockJwtRevokePayload);
    vi.mocked(addRevokedAccessToken).mockResolvedValue(undefined);
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'header.payload.signature' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(addRevokedAccessToken)).toHaveBeenCalledWith(
      mockEnv.DB,
      mockJwtRevokePayload.jti,
      mockJwtRevokePayload.exp
    );
    expect(vi.mocked(revokeRefreshToken)).not.toHaveBeenCalled();
  });

  it('JWTアクセストークン（期限切れ）→ 200 + addRevokedAccessTokenは呼ばれない', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 100;
    vi.mocked(verifyAccessToken).mockResolvedValue({ ...mockJwtRevokePayload, exp: pastExp });
    vi.mocked(addRevokedAccessToken).mockResolvedValue(undefined);
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'header.payload.signature' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(addRevokedAccessToken)).not.toHaveBeenCalled();
  });

  it('JWT署名が無効な場合 → 200 OK（RFC 7009: エラーを無視）', async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error('invalid signature'));
    vi.mocked(addRevokedAccessToken).mockResolvedValue(undefined);
    const res = await sendRequest(app, '/api/token/revoke', {
      body: { token: 'header.payload.invalid_sig' },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(addRevokedAccessToken)).not.toHaveBeenCalled();
  });

  it('form-encoded: tokenが未指定 → { error: invalid_request } + 400', async () => {
    const res = await sendRequest(app, '/api/token/revoke', {
      formBody: {},
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });
});

// ===== POST /api/token/ — grant_type 振り分け =====
describe('POST /api/token/ — 未サポートのgrant_type', () => {
  const app = buildApp();

  it('grant_type未指定 → { error: unsupported_grant_type } + 400', async () => {
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {},
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('unsupported_grant_type');
  });

  it('未知のgrant_type → { error: unsupported_grant_type } + 400', async () => {
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: { grant_type: 'client_credentials' },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('unsupported_grant_type');
  });

  it('Content-Type未サポート → { error: invalid_request } + 400', async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'grant_type=authorization_code',
      }),
      undefined,
      mockEnv as unknown as Record<string, string>
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });
});

// ===== POST /api/token/ — authorization_code grant =====
describe('POST /api/token/ — authorization_code grant', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue('hashed-value');
    vi.mocked(findServiceByClientId).mockResolvedValue(mockService as never);
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue(mockAuthCode as never);
    vi.mocked(normalizeRedirectUri).mockReturnValue('http://localhost:51234/callback');
    vi.mocked(matchRedirectUri).mockReturnValue(true);
    vi.mocked(generateCodeChallenge).mockResolvedValue('expected-challenge');
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(signAccessToken).mockResolvedValue('mock-access-token');
    vi.mocked(generateToken).mockReturnValue('mock-refresh-token');
    vi.mocked(createRefreshToken).mockResolvedValue(undefined);
    vi.mocked(signIdToken).mockResolvedValue('mock-id-token');
  });

  it('codeが未指定 → { error: invalid_request } + 400', async () => {
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        redirect_uri: 'http://localhost:51234/callback',
        client_id: 'test-client-id',
        code_verifier: 'a'.repeat(43),
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('redirect_uriが未指定 → { error: invalid_request } + 400', async () => {
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'test-code',
        client_id: 'test-client-id',
        code_verifier: 'a'.repeat(43),
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('code_verifierが未指定 → { error: invalid_request } + 400', async () => {
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'http://localhost:51234/callback',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('存在しないclient_id → { error: invalid_client } + 401 + WWW-Authenticate', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'http://localhost:51234/callback',
        client_id: 'unknown-client',
        code_verifier: 'a'.repeat(43),
      },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_client');
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="0g0-id"');
  });

  it('認可コードが存在しない → { error: invalid_grant } + 400', async () => {
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'bad-code',
        redirect_uri: 'http://localhost:51234/callback',
        client_id: 'test-client-id',
        code_verifier: 'a'.repeat(43),
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_grant');
  });

  it('service_idが不一致 → { error: invalid_grant } + 400', async () => {
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
      ...mockAuthCode,
      service_id: 'other-service-id',
    } as never);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'http://localhost:51234/callback',
        client_id: 'test-client-id',
        code_verifier: 'a'.repeat(43),
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_grant');
  });

  it('redirect_uriが不一致 → { error: invalid_grant } + 400', async () => {
    vi.mocked(matchRedirectUri).mockReturnValue(false);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'http://localhost:9999/other',
        client_id: 'test-client-id',
        code_verifier: 'a'.repeat(43),
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_grant');
  });

  it('PKCE不一致 → { error: invalid_grant } + 400', async () => {
    vi.mocked(timingSafeEqual).mockReturnValue(false);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'http://localhost:51234/callback',
        client_id: 'test-client-id',
        code_verifier: 'wrong-verifier'.padEnd(43, 'x'),
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_grant');
  });

  it('ユーザーが存在しない → { error: invalid_grant } + 400', async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'http://localhost:51234/callback',
        client_id: 'test-client-id',
        code_verifier: 'a'.repeat(43),
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_grant');
  });

  it('BANされたユーザー → { error: access_denied } + 403', async () => {
    vi.mocked(findUserById).mockResolvedValue({ ...mockUser, banned_at: '2024-01-01T00:00:00Z' });
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'http://localhost:51234/callback',
        client_id: 'test-client-id',
        code_verifier: 'a'.repeat(43),
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('access_denied');
  });

  it('openidスコープあり → id_tokenを含む成功レスポンス', async () => {
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'http://localhost:51234/callback',
        client_id: 'test-client-id',
        code_verifier: 'a'.repeat(43),
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      access_token: string;
      refresh_token: string;
      id_token: string;
      token_type: string;
      expires_in: number;
    }>();
    expect(body.access_token).toBe('mock-access-token');
    expect(body.refresh_token).toBe('mock-refresh-token');
    expect(body.id_token).toBe('mock-id-token');
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(900);
  });

  it('openidスコープなし → id_tokenを含まない成功レスポンス', async () => {
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
      ...mockAuthCode,
      scope: 'profile email',
    } as never);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'http://localhost:51234/callback',
        client_id: 'test-client-id',
        code_verifier: 'a'.repeat(43),
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.access_token).toBe('mock-access-token');
    expect(body.id_token).toBeUndefined();
  });

  it('パブリッククライアント + code_challengeがない認可コード → PKCE必須エラー', async () => {
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
      ...mockAuthCode,
      code_challenge: null,
    } as never);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'http://localhost:51234/callback',
        client_id: 'test-client-id',
        code_verifier: 'a'.repeat(43),
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; error_description: string }>();
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toBe('PKCE is required for public clients');
  });

  it('application/json形式でも動作する', async () => {
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      body: {
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'http://localhost:51234/callback',
        client_id: 'test-client-id',
        code_verifier: 'a'.repeat(43),
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ access_token: string }>();
    expect(body.access_token).toBe('mock-access-token');
  });

  it('normalizeRedirectUriがnullを返す場合（無効URI）→ { error: invalid_grant } + 400', async () => {
    vi.mocked(normalizeRedirectUri).mockReturnValue(null);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'javascript:alert(1)',
        client_id: 'test-client-id',
        code_verifier: 'a'.repeat(43),
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; error_description: string }>();
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toBe('redirect_uri mismatch');
  });

  it('Confidentialクライアント（Basic認証）+ code_challengeなし → PKCE不要で成功', async () => {
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
      ...mockAuthCode,
      code_challenge: null,
      scope: 'profile email',
    } as never);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'http://localhost:51234/callback',
        client_id: 'test-client-id',
        code_verifier: 'a'.repeat(43),
      },
      authHeader: makeBasicAuth('test-client-id', 'secret'),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ access_token: string; refresh_token: string }>();
    expect(body.access_token).toBe('mock-access-token');
    expect(body.refresh_token).toBe('mock-refresh-token');
  });
});

// ===== POST /api/token/ — refresh_token grant =====
describe('POST /api/token/ — refresh_token grant', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue('hashed-token');
    vi.mocked(findServiceByClientId).mockResolvedValue(mockService as never);
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(mockRefreshToken as never);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken as never);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(unrevokeRefreshToken).mockResolvedValue(true);
    vi.mocked(revokeTokenFamily).mockResolvedValue(undefined);
    vi.mocked(findRefreshTokenById).mockResolvedValue(mockRefreshToken as never);
    vi.mocked(signAccessToken).mockResolvedValue('new-access-token');
    vi.mocked(generateToken).mockReturnValue('new-refresh-token');
    vi.mocked(createRefreshToken).mockResolvedValue(undefined);
  });

  it('refresh_tokenが未指定 → { error: invalid_request } + 400', async () => {
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('存在しないclient_id → { error: invalid_client } + 401 + WWW-Authenticate', async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'some-token',
        client_id: 'unknown-client',
      },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_client');
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="0g0-id"');
  });

  it('トークンが存在しない → { error: invalid_grant } + 400', async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'nonexistent-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_grant');
  });

  it('rotationで失効済みトークンの再利用 → reuseDetected + family全失効', async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: '2024-01-01T00:00:00Z',
      revoked_reason: 'rotation',
    } as never);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'reused-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_grant');
    expect(vi.mocked(revokeTokenFamily)).toHaveBeenCalledWith(
      mockEnv.DB,
      'family-1',
      'reuse_detected'
    );
  });

  it('グレースピリオド内（30秒以内）のrotation再利用 → "Token rotation in progress" + family失効なし', async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: new Date(Date.now() - 10_000).toISOString(), // 10秒前（グレースピリオド内）
      revoked_reason: 'rotation',
    } as never);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'recently-rotated-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; error_description: string }>();
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toBe('Token rotation in progress, please retry');
    // グレースピリオド内はfamilyを失効させない
    expect(vi.mocked(revokeTokenFamily)).not.toHaveBeenCalled();
  });

  it('rotation + revoked_atがnull → 0時点とみなしグレースピリオド超過 → family全失効', async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: null,
      revoked_reason: 'rotation',
    } as never);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'null-revokedat-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_grant');
    expect(vi.mocked(revokeTokenFamily)).toHaveBeenCalledWith(
      mockEnv.DB,
      'family-1',
      'reuse_detected'
    );
  });

  it('rotation以外で失効済みトークン → { error: invalid_grant } (family失効なし)', async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: '2024-01-01T00:00:00Z',
      revoked_reason: 'user_logout',
    } as never);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'revoked-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_grant');
    expect(vi.mocked(revokeTokenFamily)).not.toHaveBeenCalled();
  });

  it('service_idが不一致 → unrevokeして { error: invalid_grant } + 400', async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue({
      ...mockRefreshToken,
      service_id: 'other-service-id',
    } as never);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'other-service-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_grant');
    expect(vi.mocked(unrevokeRefreshToken)).toHaveBeenCalledWith(mockEnv.DB, 'rt-id');
  });

  it('service_id不一致 + 並行reuse_detected → unrevokeせず { error: invalid_grant } + 400', async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue({
      ...mockRefreshToken,
      service_id: 'other-service-id',
    } as never);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: new Date().toISOString(),
      revoked_reason: 'reuse_detected',
    } as never);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'other-service-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; error_description: string }>();
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toBe('Token reuse detected');
    expect(vi.mocked(unrevokeRefreshToken)).not.toHaveBeenCalled();
  });

  it('期限切れトークン → { error: invalid_grant } + 400（unrevokeなし: 期限切れトークンのrotation状態解除は不要）', async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue({
      ...mockRefreshToken,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    } as never);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'expired-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_grant');
    // 期限切れトークンはunrevokeせずそのままinvalid_grantを返す（セキュリティ修正: 2026-04-05）
    expect(vi.mocked(unrevokeRefreshToken)).not.toHaveBeenCalled();
  });

  it('期限切れ + 並行reuse_detected → unrevokeせず { error: invalid_grant } + 400', async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue({
      ...mockRefreshToken,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    } as never);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: new Date().toISOString(),
      revoked_reason: 'reuse_detected',
    } as never);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'expired-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; error_description: string }>();
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toBe('Token reuse detected');
    expect(vi.mocked(unrevokeRefreshToken)).not.toHaveBeenCalled();
  });

  it('ユーザーが存在しない → { error: invalid_grant } + 400', async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'valid-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_grant');
  });

  it('BANされたユーザー → { error: access_denied } + 403', async () => {
    vi.mocked(findUserById).mockResolvedValue({ ...mockUser, banned_at: '2024-01-01T00:00:00Z' });
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'valid-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('access_denied');
  });

  it('正常なローテーション → 新しいaccess_token + refresh_tokenを返す', async () => {
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'valid-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    }>();
    expect(body.access_token).toBe('new-access-token');
    expect(body.refresh_token).toBe('new-refresh-token');
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(900);
  });

  it('スコープが保存されている場合は引き継がれる', async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue({
      ...mockRefreshToken,
      scope: 'profile email',
    } as never);
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'valid-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ scope: string }>();
    expect(body.scope).toBe('profile email');
  });

  it('issueTokenPairが例外をスロー → { error: server_error } + 500', async () => {
    vi.mocked(signAccessToken).mockRejectedValue(new Error('key not available'));
    const res = await sendRequest(app, '/api/token', {
      method: 'POST',
      formBody: {
        grant_type: 'refresh_token',
        refresh_token: 'valid-token',
        client_id: 'test-client-id',
      },
    });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: string; error_description: string }>();
    expect(body.error).toBe('server_error');
    expect(body.error_description).toBe('Token operation failed');
  });
});
