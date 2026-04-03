import { createMiddleware } from 'hono/factory';
import type { IdpEnv } from '@0g0-id/shared';
import { timingSafeEqual } from '@0g0-id/shared';

const INTERNAL_SECRET_HEADER = 'X-Internal-Secret';

/**
 * BFF→IdP間のService Bindings呼び出しを検証するミドルウェア。
 *
 * 許可条件（いずれか1つを満たせば通過）:
 * 1. X-Internal-Secret ヘッダーが INTERNAL_SERVICE_SECRET と一致（BFFからのService Bindings呼び出し）
 * 2. Authorization: Basic ... ヘッダーが存在（サービスOAuthクライアントの認証情報付き呼び出し）
 *
 * INTERNAL_SERVICE_SECRET が未設定の場合はミドルウェアをスキップ（開発環境向け）。
 */
export const serviceBindingMiddleware = createMiddleware<{ Bindings: IdpEnv }>(
  async (c, next) => {
    const secret = c.env.INTERNAL_SERVICE_SECRET;

    // シークレット未設定時はスキップ（開発環境向けグレースフルデグラデーション）
    if (!secret) {
      await next();
      return;
    }

    // 条件1: X-Internal-Secret ヘッダーによるBFF検証
    const headerSecret = c.req.header(INTERNAL_SECRET_HEADER);
    if (headerSecret && timingSafeEqual(headerSecret, secret)) {
      await next();
      return;
    }

    // 条件2: Authorization: Basic ヘッダーによるサービスOAuthクライアント認証
    // （実際の認証情報の検証はルートハンドラ内で行われる）
    const authHeader = c.req.header('Authorization');
    if (authHeader && authHeader.startsWith('Basic ')) {
      await next();
      return;
    }

    return c.json(
      { error: { code: 'FORBIDDEN', message: 'Internal service access required' } },
      403
    );
  }
);
