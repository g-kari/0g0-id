import {
  generateToken,
  sha256,
  signAccessToken,
  createRefreshToken,
} from '@0g0-id/shared';
import type { IdpEnv, User } from '@0g0-id/shared';

/** リフレッシュトークンの有効期限（30日） */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * アクセストークンとリフレッシュトークンのペアを発行する。
 *
 * BFF内部認証（serviceId=null, clientId省略）と
 * OAuthクライアント向け（serviceId/clientId必須）の両方に対応。
 */
export async function issueTokenPair(
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
    scope: scope ?? null,
  });

  return { accessToken, refreshToken };
}

/**
 * RFC 6749 §5.1 準拠のトークンレスポンスオブジェクトを構築する。
 */
export function buildTokenResponse(
  accessToken: string,
  refreshToken: string,
  scope?: string,
  idToken?: string
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 900,
    refresh_token: refreshToken,
  };
  if (idToken) response['id_token'] = idToken;
  if (scope) response['scope'] = scope;
  return response;
}
