import {
  generateToken,
  sha256,
  generatePairwiseSub,
  signAccessToken,
  signIdToken,
  createRefreshToken,
} from "@0g0-id/shared";
import type { AccessTokenInput, IdpEnv, User } from "@0g0-id/shared";

/** リフレッシュトークンの有効期限（30日） */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * resource の登録世代が発行直前に消えていた場合のエラー。
 * 検証通過後に resource 登録が削除されると、世代ガード付き INSERT が
 * 後継トークンの作成を抑止し、このエラーになる。呼び出し側は
 * 「resource は登録されていない」として扱い、旧トークンの復活は試みない。
 */
export class ResourceRegistrationGoneError extends Error {
  constructor() {
    super("Resource registration no longer exists");
    this.name = "ResourceRegistrationGoneError";
  }
}

/** アクセストークンの有効期限（秒）：15分 */
export const ACCESS_TOKEN_TTL_SECONDS = 900;

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
  options: {
    serviceId: string | null;
    clientId?: string;
    familyId?: string;
    scope?: string;
    /** RFC 8707: 指定時はこの resource URI が aud になる（clientId より優先） */
    resource?: string | null;
    /**
     * 発行時点で検証した resource_servers 行の id（登録世代）。
     * resource 束縛トークンでは必須。作成は世代ガード付き INSERT になり、
     * 検証後に登録が削除されていた場合は ResourceRegistrationGoneError を投げる。
     */
    resourceServerId?: string | null;
  },
): Promise<{ accessToken: string; refreshToken: string }> {
  const {
    serviceId,
    clientId,
    familyId = crypto.randomUUID(),
    scope,
    resource,
    resourceServerId,
  } = options;
  if ((serviceId !== null) !== (clientId !== undefined) || clientId === "") {
    throw new Error("Service tokens require a matching serviceId and clientId");
  }
  if (resource != null && clientId === undefined) {
    throw new Error("Resource-bound tokens require a clientId");
  }
  if (resource != null && !resourceServerId) {
    throw new Error("Resource-bound tokens require a resourceServerId");
  }

  const accessTokenInput: AccessTokenInput =
    clientId === undefined
      ? {
          iss: env.IDP_ORIGIN,
          sub: user.id,
          aud: env.IDP_ORIGIN,
          email: user.email,
          role: user.role,
          scope,
          cid: undefined,
        }
      : {
          iss: env.IDP_ORIGIN,
          sub: user.id,
          aud: resource ?? clientId,
          scope,
          cid: clientId,
        };
  const accessToken = await signAccessToken(
    accessTokenInput,
    env.JWT_PRIVATE_KEY,
    env.JWT_PUBLIC_KEY,
  );

  const refreshToken = generateToken(32);
  const tokenHash = await sha256(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();

  // サービス連携時はペアワイズsubを事前計算して保存（外部API逆引き用）
  const pairwiseSub = clientId
    ? await generatePairwiseSub(clientId, user.id, env.PAIRWISE_SALT)
    : null;

  const created = await createRefreshToken(db, {
    id: crypto.randomUUID(),
    userId: user.id,
    serviceId,
    tokenHash,
    familyId,
    expiresAt,
    pairwiseSub,
    scope: scope || null,
    resource: resource ?? null,
    resourceServerId: resource != null ? resourceServerId : null,
  });
  if (!created) {
    // 検証から発行までの間に resource 登録が削除された。
    // 後継トークンは作られていない（世代ガード付き INSERT が抑止した）。
    throw new ResourceRegistrationGoneError();
  }

  return { accessToken, refreshToken };
}

/**
 * RFC 6749 §5.1 準拠のトークンレスポンスオブジェクトを構築する。
 */
export function buildTokenResponse(
  accessToken: string,
  refreshToken: string,
  scope?: string,
  idToken?: string,
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
  };
  if (idToken) response["id_token"] = idToken;
  if (scope) response["scope"] = scope;
  return response;
}

/**
 * OIDC IDトークンを発行する（openid スコープがある場合のみ）。
 *
 * pairwise sub の計算と signIdToken 呼び出しを共通化する。
 */
export async function issueIdToken(
  env: IdpEnv,
  user: User,
  service: { client_id: string },
  scope: string | undefined,
  options?: { nonce?: string; amr?: string[] },
): Promise<string | undefined> {
  if (!scope?.split(" ").includes("openid")) {
    return undefined;
  }

  const pairwiseSub = await generatePairwiseSub(service.client_id, user.id, env.PAIRWISE_SALT);
  const authTime = Math.floor(Date.now() / 1000);

  return signIdToken(
    {
      iss: env.IDP_ORIGIN,
      sub: pairwiseSub,
      aud: service.client_id,
      authTime,
      nonce: options?.nonce,
      // Do not disclose the upstream provider to an RP by default.
    },
    env.JWT_PRIVATE_KEY,
    env.JWT_PUBLIC_KEY,
  );
}
