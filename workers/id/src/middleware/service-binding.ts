import { createMiddleware } from "hono/factory";
import type { IdpEnv } from "@0g0-id/shared";
import { createLogger } from "@0g0-id/shared";
import { authenticateService } from "../utils/service-auth";
import {
  classifyInternalSecret,
  getConfiguredInternalSecrets,
  INTERNAL_SECRET_HEADER,
} from "../utils/internal-secret";

const sbLogger = createLogger("service-binding");

/**
 * BFF→IdP 間および外部OAuthクライアント呼び出しを検証するミドルウェア。
 *
 * 許可条件（いずれか1つを満たせば通過）:
 * 1. X-Internal-Secret ヘッダーが以下のいずれかと一致（BFF 呼び出し）:
 *    - INTERNAL_SERVICE_SECRET_USER（user BFF 専用）
 *    - INTERNAL_SERVICE_SECRET_ADMIN（admin BFF 専用）
 *    - INTERNAL_SERVICE_SECRET（共有シークレット・後方互換・deprecation 警告対象）
 * 2. Authorization: Basic ヘッダーのクライアント認証情報がDBと一致（外部OAuthクライアント）
 *
 * シークレットが1つも設定されていない場合:
 * - 本番環境（HTTPS）: 403 を返却
 * - 開発環境: スキップ（グレースフルデグラデーション）
 *
 * BFF 毎に専用シークレットを分離することで、漏洩時の影響範囲を限定できる（issue #156）。
 *
 * 認証結果（成功 / mismatch / deprecated shared secret / 403）を構造化ログで記録し、
 * 移行中のドリフト検知と不正アクセス試行の観測を可能にする。
 */
export const serviceBindingMiddleware = createMiddleware<{ Bindings: IdpEnv }>(async (c, next) => {
  const configuredSecrets = getConfiguredInternalSecrets(c.env);
  const method = c.req.method;
  const path = c.req.path;

  if (configuredSecrets.length === 0) {
    if (c.env.IDP_ORIGIN?.startsWith("https://")) {
      sbLogger.error(
        "内部シークレットが1つも設定されていません。本番環境ではService Bindings保護が必須のため、リクエストを拒否します。",
        { method, path },
      );
      return c.json(
        { error: { code: "FORBIDDEN", message: "Service binding misconfigured" } },
        403,
      );
    }
    // 開発環境のみの graceful bypass。env 設定ミスで本番が http:// 起動した場合に気づけるよう警告も出す。
    sbLogger.warn(
      "service binding bypassed: no internal secrets configured (non-prod only — production requires INTERNAL_SERVICE_SECRET_USER/_ADMIN)",
      { method, path, idpOrigin: c.env.IDP_ORIGIN ?? null },
    );
    await next();
    return;
  }

  // 条件1: X-Internal-Secret ヘッダーによる BFF 検証
  const kind = classifyInternalSecret(c.env, c.req.raw);
  if (kind !== "none") {
    sbLogger.info("internal secret authenticated", { kind, method, path });
    if (kind === "shared") {
      // 共有シークレットでの通過は後方互換のため残しているが、個別シークレット移行を促すために警告。
      sbLogger.warn(
        "deprecated shared INTERNAL_SERVICE_SECRET を使用した内部認証。BFF 毎の個別シークレット（_USER/_ADMIN）に移行してください（issue #156）。",
        { method, path },
      );
    }
    await next();
    if (kind === "shared") {
      // RFC 9745: `Deprecation` ヘッダでリソース／認証方式が非推奨であることを呼び出し元に通知。
      // 構造化ログだけだと呼び出し元 BFF 側で気づきにくいため、Response ヘッダでも並行通知する（issue #156）。
      // Cloudflare Workers では確定済み Response の headers は immutable なため、Hono の `c.header` を使う。
      c.header("Deprecation", "true");
      c.header("Link", '<https://github.com/g-kari/0g0-id/issues/156>; rel="deprecation"', {
        append: true,
      });
    }
    return;
  }

  // 条件1 で通らなかった理由が「ヘッダーあり + 不一致」か「ヘッダーなし」かを区別して観測可能に。
  const hadHeader = c.req.header(INTERNAL_SECRET_HEADER) !== undefined;
  if (hadHeader) {
    sbLogger.warn("internal secret mismatch", { method, path });
  }

  // 条件2: Authorization: Basic ヘッダーによるサービスOAuthクライアント認証
  const authHeader = c.req.header("Authorization");
  if (authHeader && authHeader.startsWith("Basic ")) {
    try {
      const service = await authenticateService(c.env.DB, authHeader);
      if (service) {
        sbLogger.info("service client authenticated", {
          serviceId: service.id,
          method,
          path,
        });
        await next();
        return;
      }
      sbLogger.warn("service client authentication failed", { method, path });
    } catch (err) {
      sbLogger.error(
        "service client authentication error",
        err instanceof Error ? err : new Error(String(err)),
      );
      return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
    }
  }

  sbLogger.warn("service binding access denied", { method, path });
  return c.json({ error: { code: "FORBIDDEN", message: "Internal service access required" } }, 403);
});
