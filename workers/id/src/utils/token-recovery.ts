import { unrevokeRefreshToken } from '@0g0-id/shared';

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
    const unrevoked = await unrevokeRefreshToken(db, tokenId);
    if (!unrevoked) {
      console.error(`${context} unrevokeRefreshToken returned false — token may remain revoked:`, tokenId);
    }
  } catch (err) {
    console.error(`${context} Failed to unrevoke refresh token:`, err);
  }
}
