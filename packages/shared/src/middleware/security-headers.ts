import type { MiddlewareHandler } from 'hono';

/**
 * HTTPセキュリティヘッダーを全レスポンスに付与するミドルウェア。
 *
 * 設定するヘッダー:
 * - X-Frame-Options: SAMEORIGIN          — クリックジャッキング防止
 * - X-Content-Type-Options: nosniff      — MIMEタイプスニッフィング防止
 * - Referrer-Policy: strict-origin-when-cross-origin — リファラー情報の最小化
 * - X-Permitted-Cross-Domain-Policies: none — Flash/Silverlight等のクロスドメインポリシー制限
 * - Permissions-Policy                   — ブラウザ機能・センシティブAPIの包括的無効化
 * - Strict-Transport-Security            — HTTPSの強制（HSTS、1年間、サブドメイン含む、preload）
 * - Content-Security-Policy              — デフォルト厳格ポリシー（HTMLページは必要に応じてオーバーライド）
 * - Cross-Origin-Opener-Policy           — クロスオリジンウィンドウからのwindowオブジェクトアクセス防止
 * - Cache-Control: no-store             — レスポンスのキャッシュ禁止（RFC 6749 OAuth 2.0 必須要件）
 */
export const securityHeaders = (): MiddlewareHandler => {
  return async (c, next) => {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    c.header('X-Frame-Options', 'SAMEORIGIN');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('X-Permitted-Cross-Domain-Policies', 'none');
    c.header(
      'Permissions-Policy',
      'geolocation=(), microphone=(), camera=(), payment=(), usb=(), bluetooth=(), magnetometer=(), gyroscope=(), accelerometer=(), ambient-light-sensor=(), display-capture=(), screen-wake-lock=()',
    );
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    // RFC 6749 Section 5.1 / RFC 6819 準拠: トークン・ユーザー情報等の機密レスポンスをキャッシュ禁止
    // /.well-known/* 等の公開エンドポイントは個別に Cache-Control をオーバーライド可能
    c.header('Cache-Control', 'no-store');
    await next();
  };
};
