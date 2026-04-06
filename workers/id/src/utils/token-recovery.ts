import { unrevokeRefreshToken, findRefreshTokenById, createLogger } from '@0g0-id/shared';

const recoveryLogger = createLogger('token-recovery');

/**
 * リフレッシュトークンの失効解除を試みる。
 * 失敗してもメインフローは継続させるため、エラーはログのみ。
 *
 * @param db - D1 データベース
 * @param tokenId - 解除対象のトークン ID
 * @param context - ログ出力用のコンテキスト文字列（例: '[token] service_id mismatch 後'）
 */
export async function attemptUnrevokeToken(
  db: D1Database,
  tokenId: string,
  context: string,
): Promise<void> {
  try {
    const token = await findRefreshTokenById(db, tokenId);
    if (token?.revoked_reason === 'reuse_detected') {
      recoveryLogger.warn(
        `${context} token ${tokenId} has revoked_reason='reuse_detected' — skipping unrevoke to preserve security state`,
      );
      return;
    }
    const unrevoked = await unrevokeRefreshToken(db, tokenId);
    if (!unrevoked) {
      recoveryLogger.error(`${context} unrevokeRefreshToken returned false — token may remain revoked:`, tokenId);
    }
  } catch (err) {
    recoveryLogger.error(`${context} Failed to unrevoke refresh token:`, err);
  }
}
