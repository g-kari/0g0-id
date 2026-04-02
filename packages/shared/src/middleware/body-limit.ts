import { bodyLimit } from 'hono/body-limit';

/**
 * リクエストボディサイズ制限ミドルウェア（メモリ消耗攻撃防止）。
 * 全ワーカー共通で使用する。デフォルトは64KB。
 */
export function bodyLimitMiddleware(maxSize = 64 * 1024) {
  return bodyLimit({
    maxSize,
    onError: (c) => {
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } }, 413);
    },
  });
}
