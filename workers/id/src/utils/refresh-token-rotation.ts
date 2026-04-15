import {
  findAndRevokeRefreshToken,
  findRefreshTokenByHash,
  revokeTokenFamily,
} from "@0g0-id/shared";
import type { IdpEnv, User, RefreshToken } from "@0g0-id/shared";
import { attemptUnrevokeToken } from "./token-recovery";
import { issueTokenPair } from "./token-pair";

/** リフレッシュトークンのローテーション前バリデーション結果 */
export type RefreshTokenValidationResult =
  | { ok: true; storedToken: RefreshToken }
  | { ok: false; reason: "TOKEN_ROTATED" | "TOKEN_REUSE" | "INVALID_TOKEN" };

/**
 * リフレッシュトークンをアトミックに失効させ、reuse detection を行う。
 * TOCTOU 競合状態防止: RFC 6819 §5.2.2.3
 *
 * - 並行リクエスト対策: rotation から 30 秒以内の再提示は BFF の並行リフレッシュ競合とみなし、
 *   ファミリー全失効を行わず TOKEN_ROTATED を返す。
 * - 30 秒超の再提示は本物のリプレイ攻撃とみなしてファミリー全失効し TOKEN_REUSE を返す。
 */
export async function validateAndRevokeRefreshToken(
  db: D1Database,
  tokenHash: string,
): Promise<RefreshTokenValidationResult> {
  const storedToken = await findAndRevokeRefreshToken(db, tokenHash, "rotation");

  if (!storedToken) {
    const existingToken = await findRefreshTokenByHash(db, tokenHash);
    if (existingToken) {
      if (existingToken.revoked_reason === "rotation") {
        const revokedMs = existingToken.revoked_at
          ? new Date(existingToken.revoked_at).getTime()
          : 0;
        if (Date.now() - revokedMs < 30_000) {
          return { ok: false, reason: "TOKEN_ROTATED" };
        }
        await revokeTokenFamily(db, existingToken.family_id, "reuse_detected");
        return { ok: false, reason: "TOKEN_REUSE" };
      }
    }
    return { ok: false, reason: "INVALID_TOKEN" };
  }

  return { ok: true, storedToken };
}

/** 新トークンペア発行結果 */
export type IssueWithRecoveryResult =
  | { ok: true; accessToken: string; refreshToken: string }
  | { ok: false; reason: "TOKEN_REUSE" | "INTERNAL_ERROR" };

/**
 * 新しいアクセストークン・リフレッシュトークンを発行し、
 * 失敗時はレース条件を考慮した回復処理を行う。
 *
 * issueTokenPair 失敗時:
 * - 並行リクエストが reuse_detected を発動していた場合は TOKEN_REUSE を返す
 * - それ以外は旧トークンの失効を取り消し（attemptUnrevokeToken）、INTERNAL_ERROR を返す
 */
export async function issueTokenPairWithRecovery(
  db: D1Database,
  env: IdpEnv,
  user: User,
  issueParams: { serviceId: string | null; clientId?: string; familyId?: string; scope?: string },
  storedTokenId: string,
  tokenHash: string,
  logger: { error: (msg: string, extra?: unknown) => void },
  context: string,
): Promise<IssueWithRecoveryResult> {
  try {
    const tokens = await issueTokenPair(db, env, user, issueParams);
    return { ok: true, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  } catch (e) {
    logger.error(`${context}: issueTokenPair failed`, e);
    const currentToken = await findRefreshTokenByHash(db, tokenHash);
    if (currentToken && currentToken.revoked_reason === "reuse_detected") {
      return { ok: false, reason: "TOKEN_REUSE" };
    }
    await attemptUnrevokeToken(db, storedTokenId, `[${context}] issueTokenPair failure 後`);
    return { ok: false, reason: "INTERNAL_ERROR" };
  }
}
