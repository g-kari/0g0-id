import { createMiddleware } from "hono/factory";
import type { IdpEnv } from "@0g0-id/shared";
import { createLogger } from "@0g0-id/shared";
import { authenticateService } from "../utils/service-auth";
import { getConfiguredInternalSecrets, hasValidInternalSecret } from "../utils/internal-secret";

const sbLogger = createLogger("service-binding");

/**
 * BFF→IdP 間および外部OAuthクライアント呼び出しを検証するミドルウェア。
 *
 * 許可条件（いずれか1つを満たせば通過）:
 * 1. X-Internal-Secret ヘッダーが以下のいずれかと一致（BFF 呼び出し）:
 *    - INTERNAL_SERVICE_SECRET_USER（user BFF 専用）
 *    - INTERNAL_SERVICE_SECRET_ADMIN（admin BFF 専用）
 *    - INTERNAL_SERVICE_SECRET（共有シークレット・後方互換）
 * 2. Authorization: Basic ヘッダーのクライアント認証情報がDBと一致（外部OAuthクライアント）
 *
 * シークレットが1つも設定されていない場合:
 * - 本番環境（HTTPS）: 403 を返却
 * - 開発環境: スキップ（グレースフルデグラデーション）
 *
 * BFF 毎に専用シークレットを分離することで、漏洩時の影響範囲を限定できる（issue #156）。
 */
export const serviceBindingMiddleware = createMiddleware<{ Bindings: IdpEnv }>(async (c, next) => {
  // BFF 毎の個別シークレット + 共有シークレット（後方互換）を列挙（issue #156）
  const configuredSecrets = getConfiguredInternalSecrets(c.env);

  // シークレット未設定時の処理
  if (configuredSecrets.length === 0) {
    // 本番環境（https://）ではシークレット必須 — 設定漏れによるセキュリティホールを防止
    if (c.env.IDP_ORIGIN?.startsWith("https://")) {
      sbLogger.error(
        "内部シークレットが1つも設定されていません。本番環境ではService Bindings保護が必須のため、リクエストを拒否します。",
      );
      return c.json(
        { error: { code: "FORBIDDEN", message: "Service binding misconfigured" } },
        403,
      );
    }
    // 開発環境のみスキップ（グレースフルデグラデーション）
    await next();
    return;
  }

  // 条件1: X-Internal-Secret ヘッダーによる BFF 検証
  // 設定済みシークレットのいずれかと timingSafeEqual で一致すれば通過
  if (hasValidInternalSecret(c.env, c.req.raw)) {
    await next();
    return;
  }

  // 条件2: Authorization: Basic ヘッダーによるサービスOAuthクライアント認証
  // 存在チェックだけでなく、実際にDB上のクライアント認証情報と照合する
  const authHeader = c.req.header("Authorization");
  if (authHeader && authHeader.startsWith("Basic ")) {
    try {
      const service = await authenticateService(c.env.DB, authHeader);
      if (service) {
        await next();
        return;
      }
    } catch {
      return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
    }
  }

  return c.json({ error: { code: "FORBIDDEN", message: "Internal service access required" } }, 403);
});
