import { Hono } from 'hono';
import {
  sha256,
  createLogger,
  findServiceByClientId,
  findUserById,
  createDeviceCode,
  findDeviceCodeByUserCode,
  findDeviceCodeByHash,
  approveDeviceCode,
  denyDeviceCode,
  tryUpdateDeviceCodePolledAt,
  deleteDeviceCode,
  deleteApprovedDeviceCode,
  deleteExpiredDeviceCodes,
  generateToken,
  signAccessToken,
  createRefreshToken,
} from '@0g0-id/shared';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { tokenApiRateLimitMiddleware } from '../middleware/rate-limit';
import { authMiddleware, rejectServiceTokenMiddleware, rejectBannedUserMiddleware } from '../middleware/auth';
import { parseAllowedScopes } from '../utils/scopes';

const deviceLogger = createLogger('device');

/** デバイスコードの有効期限（秒） */
const DEVICE_CODE_LIFETIME_SEC = 600;

/** ポーリング間隔（秒） */
const POLLING_INTERVAL_SEC = 5;

/** リフレッシュトークンの有効期限（30日） */
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * user_code 生成用の文字セット。
 * 紛らわしい文字（O/0/I/1/L）を除外した英数字大文字。
 */
const USER_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * 8文字のランダムなuser_codeを生成する。
 * DBにはハイフンなしで格納し、レスポンスでは "XXXX-XXXX" 形式で返す。
 */
function generateUserCode(): string {
  const len = USER_CODE_CHARS.length; // 31
  const limit = 256 - (256 % len); // 拒否サンプリング閾値（248）
  const result: string[] = [];
  while (result.length < 8) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (let i = 0; i < bytes.length && result.length < 8; i++) {
      if (bytes[i] < limit) {
        result.push(USER_CODE_CHARS[bytes[i] % len]);
      }
    }
  }
  return result.join('');
}

/** user_codeをハイフン区切りで表示用に整形する */
function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** user_code入力からハイフン・空白を除去して正規化する */
function normalizeUserCode(input: string): string {
  return input.replace(/[-\s]/g, '').toUpperCase();
}

const app = new Hono<{ Bindings: IdpEnv; Variables: { user: TokenPayload } }>();

// POST /api/device/code — デバイス認可リクエスト (RFC 8628 §3.1)
app.post('/code', tokenApiRateLimitMiddleware, async (c) => {
  // 期限切れレコードをベストエフォートで掃除
  deleteExpiredDeviceCodes(c.env.DB).catch((err) => {
    deviceLogger.warn('期限切れデバイスコードの削除に失敗', err);
  });

  // リクエストボディのパース
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

  const clientId = params['client_id'];
  if (!clientId) {
    return c.json({ error: 'invalid_request', error_description: 'client_id is required' }, 400);
  }

  // サービス（クライアント）の存在確認
  const service = await findServiceByClientId(c.env.DB, clientId);
  if (!service) {
    return c.json({ error: 'invalid_client', error_description: 'Unknown client_id' }, 400);
  }

  // スコープの検証
  const allowedScopes = parseAllowedScopes(service.allowed_scopes);
  let resolvedScope: string | undefined;
  const requestedScope = params['scope'];
  if (requestedScope) {
    const requested = requestedScope.split(' ').filter(Boolean);
    const valid = requested.filter((s) => s === 'openid' || allowedScopes.includes(s));
    resolvedScope = valid.length > 0 ? valid.join(' ') : undefined;
  } else {
    resolvedScope = ['openid', ...allowedScopes].join(' ');
  }

  // デバイスコードとユーザーコードの生成
  const deviceCode = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
  const deviceCodeHash = await sha256(deviceCode);
  const userCode = generateUserCode();
  const expiresAt = new Date(Date.now() + DEVICE_CODE_LIFETIME_SEC * 1000).toISOString();

  // user_codeの衝突リトライ（最大3回）
  let saved = false;
  let currentUserCode = userCode;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) currentUserCode = generateUserCode();
    try {
      await createDeviceCode(c.env.DB, {
        id: crypto.randomUUID(),
        deviceCodeHash,
        userCode: currentUserCode,
        serviceId: service.id,
        scope: resolvedScope ?? null,
        expiresAt,
      });
      saved = true;
      break;
    } catch (err) {
      // UNIQUE制約違反の場合はリトライ
      if (attempt < 2 && err instanceof Error && err.message.includes('UNIQUE')) {
        continue;
      }
      deviceLogger.error('デバイスコードの保存に失敗', err);
      return c.json({ error: 'server_error', error_description: 'Failed to create device code' }, 500);
    }
  }

  if (!saved) {
    return c.json({ error: 'server_error', error_description: 'Failed to create device code' }, 500);
  }

  const verificationUri = `${c.env.USER_ORIGIN}/device`;

  return c.json({
    device_code: deviceCode,
    user_code: formatUserCode(currentUserCode),
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?code=${formatUserCode(currentUserCode)}`,
    expires_in: DEVICE_CODE_LIFETIME_SEC,
    interval: POLLING_INTERVAL_SEC,
  });
});

// POST /api/device/verify — BFFから呼ばれるデバイスコード承認/拒否
// authMiddleware でアクセストークン認証、rejectServiceTokenMiddleware でサービストークン拒否
// tokenApiRateLimitMiddleware でブルートフォース対策
app.post(
  '/verify',
  tokenApiRateLimitMiddleware,
  authMiddleware,
  rejectServiceTokenMiddleware,
  rejectBannedUserMiddleware,
  async (c) => {
    // リクエストボディのパース
    let params: Record<string, string>;
    try {
      params = await c.req.json<Record<string, string>>();
    } catch {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Failed to parse request body' } }, 400);
    }

    const rawUserCode = params['user_code'];
    const action = params['action'] as string | undefined;

    if (!rawUserCode) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'user_code is required' } }, 400);
    }

    const userCode = normalizeUserCode(rawUserCode);
    if (userCode.length !== 8) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid user_code format' } }, 400);
    }

    const deviceCode = await findDeviceCodeByUserCode(c.env.DB, userCode);
    if (!deviceCode) {
      return c.json({ error: { code: 'INVALID_CODE', message: 'Unknown or expired user_code' } }, 404);
    }

    // 期限切れチェック
    if (new Date(deviceCode.expires_at) < new Date()) {
      return c.json({ error: { code: 'CODE_EXPIRED', message: 'Device code has expired' } }, 400);
    }

    // 既に承認/拒否済みの場合
    if (deviceCode.approved_at) {
      return c.json({ error: { code: 'CODE_ALREADY_USED', message: 'Device code already approved' } }, 400);
    }
    if (deviceCode.denied_at) {
      return c.json({ error: { code: 'CODE_ALREADY_USED', message: 'Device code already denied' } }, 400);
    }

    // actionなし → 情報取得のみ（BFFの検証ステップ用）
    if (!action) {
      const serviceInfo = await c.env.DB
        .prepare('SELECT name, allowed_scopes FROM services WHERE id = ?')
        .bind(deviceCode.service_id)
        .first<{ name: string; allowed_scopes: string | null }>();
      const scopes = serviceInfo?.allowed_scopes
        ? parseAllowedScopes(serviceInfo.allowed_scopes)
        : [];
      return c.json({
        data: {
          service_name: serviceInfo?.name ?? 'Unknown',
          scopes,
        },
      });
    }

    // action付き → 承認/拒否
    if (action !== 'approve' && action !== 'deny') {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'action must be "approve" or "deny"' } }, 400);
    }

    const tokenUser = c.get('user');

    if (action === 'approve') {
      await approveDeviceCode(c.env.DB, deviceCode.id, tokenUser.sub);
      return c.json({ status: 'approved' });
    } else {
      await denyDeviceCode(c.env.DB, deviceCode.id);
      return c.json({ status: 'denied' });
    }
  }
);

/**
 * device_code グラントのトークン発行を処理する。
 * token.ts の POST /api/token から呼ばれる。
 */
export async function handleDeviceCodeGrant(
  c: { env: IdpEnv; req: { header: (name: string) => string | undefined }; json: (data: unknown, status?: number) => Response },
  params: Record<string, string>
): Promise<Response> {
  const rawDeviceCode = params['device_code'];
  const clientId = params['client_id'];

  if (!rawDeviceCode) {
    return c.json({ error: 'invalid_request', error_description: 'device_code is required' }, 400);
  }
  if (!clientId) {
    return c.json({ error: 'invalid_request', error_description: 'client_id is required' }, 400);
  }

  // クライアント確認
  const service = await findServiceByClientId(c.env.DB, clientId);
  if (!service) {
    return c.json({ error: 'invalid_client' }, 401);
  }

  const deviceCodeHash = await sha256(rawDeviceCode);
  const deviceCode = await findDeviceCodeByHash(c.env.DB, deviceCodeHash);

  if (!deviceCode) {
    return c.json({ error: 'invalid_grant', error_description: 'Invalid device code' }, 400);
  }

  // サービス一致確認
  if (deviceCode.service_id !== service.id) {
    return c.json({ error: 'invalid_grant', error_description: 'Device code was not issued for this client' }, 400);
  }

  // 期限切れチェック
  if (new Date(deviceCode.expires_at) < new Date()) {
    // 期限切れのレコードを削除
    await deleteDeviceCode(c.env.DB, deviceCode.id);
    return c.json({ error: 'expired_token' }, 400);
  }

  // 拒否済みチェック
  if (deviceCode.denied_at) {
    await deleteDeviceCode(c.env.DB, deviceCode.id);
    return c.json({ error: 'access_denied' }, 400);
  }

  // slow_down チェック＋ポーリング時刻更新をアトミックに実行（レースコンディション防止）
  const pollingAllowed = await tryUpdateDeviceCodePolledAt(c.env.DB, deviceCode.id, POLLING_INTERVAL_SEC);
  if (!pollingAllowed) {
    return c.json({ error: 'slow_down' }, 400);
  }

  // まだ承認されていない場合
  if (!deviceCode.approved_at || !deviceCode.user_id) {
    return c.json({ error: 'authorization_pending' }, 400);
  }

  // 承認済みユーザー取得とBANチェック（不可逆な削除の前に実施）
  const user = await findUserById(c.env.DB, deviceCode.user_id);
  if (!user) {
    return c.json({ error: 'invalid_grant', error_description: 'User not found' }, 400);
  }
  if (user.banned_at !== null) {
    // BAN済みユーザーのdevice codeは失効させる
    await deleteDeviceCode(c.env.DB, deviceCode.id);
    return c.json({ error: 'access_denied', error_description: 'Account has been suspended' }, 403);
  }

  // 全チェック通過後にアトミック削除で二重トークン発行を防止
  const deleted = await deleteApprovedDeviceCode(c.env.DB, deviceCode.id);
  if (!deleted) {
    // 他のリクエストが先にトークンを発行済み
    return c.json({ error: 'invalid_grant', error_description: 'Device code already consumed' }, 400);
  }

  // スコープ計算
  const allowedScopes = parseAllowedScopes(service.allowed_scopes);
  let serviceScope: string | undefined;
  if (deviceCode.scope) {
    const requested = deviceCode.scope.split(' ').filter(Boolean);
    const valid = requested.filter((s) => s === 'openid' || allowedScopes.includes(s));
    serviceScope = valid.length > 0 ? valid.join(' ') : undefined;
  } else {
    serviceScope = ['openid', ...allowedScopes].join(' ');
  }

  // トークン発行（issueOAuthTokenPair と同じロジック）
  const familyId = crypto.randomUUID();

  const accessToken = await signAccessToken(
    { iss: c.env.IDP_ORIGIN, sub: user.id, aud: c.env.IDP_ORIGIN, email: user.email, role: user.role, scope: serviceScope, cid: service.client_id },
    c.env.JWT_PRIVATE_KEY,
    c.env.JWT_PUBLIC_KEY
  );

  const refreshToken = generateToken(32);
  const tokenHash = await sha256(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
  const pairwiseSub = await sha256(`${service.client_id}:${user.id}`);

  await createRefreshToken(c.env.DB, {
    id: crypto.randomUUID(),
    userId: user.id,
    serviceId: service.id,
    tokenHash,
    familyId,
    expiresAt,
    pairwiseSub,
    scope: serviceScope ?? null,
  });

  // レスポンス (RFC 6749 §5.1)
  const response: Record<string, unknown> = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 900,
    refresh_token: refreshToken,
  };
  if (serviceScope) {
    response['scope'] = serviceScope;
  }

  return c.json(response);
}

export default app;
