import type { MiddlewareHandler } from 'hono';

/**
 * HTTPセキュリティヘッダーを全レスポンスに付与するミドルウェア。
 *
 * 設定するヘッダー:
 * - X-Frame-Options: SAMEORIGIN          — クリックジャッキング防止
 * - X-Content-Type-Options: nosniff      — MIMEタイプスニッフィング防止
 * - Referrer-Policy: strict-origin-when-cross-origin — リファラー情報の最小化
 * - X-Permitted-Cross-Domain-Policies: none — Flash/Silverlight等のクロスドメインポリシー制限
 * - Permissions-Policy                   — カメラ・マイク・位置情報APIの無効化
 * - Strict-Transport-Security            — HTTPSの強制（HSTS、1年間、サブドメイン含む）                   — カメラ・マイク・位置情報APIの無効化
 */
export const securityHeaders = (): MiddlewareHandler => {
  return async (c, next) => {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    c.header('X-Frame-Options', 'SAMEORIGIN');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('X-Permitted-Cross-Domain-Policies', 'none');
    c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    await next();
  };
};
