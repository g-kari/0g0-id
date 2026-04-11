import { createMiddleware } from "hono/factory";
import type { IdpEnv } from "@0g0-id/shared";
import { timingSafeEqual, createLogger } from "@0g0-id/shared";
import { authenticateService } from "../utils/service-auth";

const INTERNAL_SECRET_HEADER = "X-Internal-Secret";
const sbLogger = createLogger("service-binding");

/**
 * BFF→IdP間のService Bindings呼び出しを検証するミドルウェア。
 *
 * 許可条件（いずれか1つを満たせば通過）:
 * 1. X-Internal-Secret ヘッダーが INTERNAL_SERVICE_SECRET と一致（BFFからのService Bindings呼び出し）
 * 2. Authorization: Basic ヘッダーのクライアント認証情報がDBと一致（外部OAuthクライアント）
 *
 * INTERNAL_SERVICE_SECRET が未設定の場合はミドルウェアをスキップ（開発環境向け）。
 * 本番環境（HTTPS）で未設定の場合は警告ログを出力する。
 */
export const serviceBindingMiddleware = createMiddleware<{ Bindings: IdpEnv }>(async (c, next) => {
  const secret = c.env.INTERNAL_SERVICE_SECRET;

  // シークレット未設定時の処理
  if (!secret) {
    // 本番環境（https://）ではシークレット必須 — 設定漏れによるセキュリティホールを防止
    if (c.env.IDP_ORIGIN?.startsWith("https://")) {
      sbLogger.error(
        "INTERNAL_SERVICE_SECRET が未設定です。本番環境ではService Bindings保護が必須のため、リクエストを拒否します。",
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

  // 条件1: X-Internal-Secret ヘッダーによるBFF検証
  const headerSecret = c.req.header(INTERNAL_SECRET_HEADER);
  if (headerSecret && timingSafeEqual(headerSecret, secret)) {
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
