import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { BffEnv } from "../types";
import { parseSession, internalServiceHeaders } from "../lib/bff";
import { buildSecureSessionRegistrationHeader, isDbscEnforceValue } from "../lib/dbsc";
import { createLogger, type Logger } from "../lib/logger";

/**
 * DBSC 必須化ミドルウェアの設定。
 */
export interface RequireDbscBoundConfig {
  /** セッション Cookie 名（例: "__Host-admin-session"） */
  sessionCookieName: string;
  /** ロガー名（観測用） */
  loggerName: string;
  /**
   * 強制モード。
   * - false (default): 未バインド検出時も通過（warn ログのみ出力）。段階的導入用。
   * - true: 未バインド検出時に 403 + Secure-Session-Registration ヘッダで拒否。
   * - "env": `env.DBSC_ENFORCE_SENSITIVE === "true"` のときに強制モードに切替。
   */
  enforce?: boolean | "env";
  /**
   * Chrome に返す `Secure-Session-Registration` ヘッダの path 属性。
   * enforce=true 時に 403 と一緒に付与され、Chrome がこの path に registration JWT を POST する。
   * 例: `"/auth/dbsc/start"`
   */
  registrationPath: string;
}

/** CSRF 安全メソッド（副作用なし）はチェックを省く */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface StatusResponse {
  data?: { device_bound?: unknown; device_bound_at?: unknown };
}

function isEnforceEnabled(config: RequireDbscBoundConfig, env: BffEnv): boolean {
  if (config.enforce === true) return true;
  if (config.enforce === "env") {
    // 判定ルール（trim + lowercase == "true"）は `isDbscEnforceValue` に一本化。
    // デプロイ preflight のガイド文言と挙動を一致させるための単一ソース。
    return isDbscEnforceValue(env.DBSC_ENFORCE_SENSITIVE);
  }
  return false;
}

async function fetchDbscStatus(
  env: BffEnv,
  sessionId: string,
  logger: Logger,
): Promise<boolean | null> {
  try {
    const resp = await env.IDP.fetch(
      new Request(`${env.IDP_ORIGIN}/auth/dbsc/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BFF-Origin": env.SELF_ORIGIN,
          ...internalServiceHeaders(env),
        },
        body: JSON.stringify({ session_id: sessionId }),
      }),
    );
    if (!resp.ok) {
      logger.warn("[require-dbsc-bound] status lookup failed", { status: resp.status });
      return null;
    }
    const body = (await resp.json()) as StatusResponse;
    const bound = body?.data?.device_bound;
    return typeof bound === "boolean" ? bound : null;
  } catch (err) {
    logger.error("[require-dbsc-bound] status lookup error", err);
    return null;
  }
}

/**
 * DBSC バインド済みセッションを必須化するミドルウェア（Phase 3）。
 *
 * 破壊的メソッド（POST/PATCH/PUT/DELETE）に対して、BFF セッションが
 * DBSC で端末バインド済みか IdP に問い合わせ、未バインドなら拒否する。
 *
 * デフォルト（enforce=false）は観測のみで通過させる。admin BFF の機密操作に
 * 初期導入する場合は enforce="env" で DBSC_ENFORCE_SENSITIVE=true のときだけ強制に切替える。
 *
 * セキュリティ考慮:
 * - 安全メソッド（GET/HEAD/OPTIONS）は常にスキップ（副作用なし & 観測不要）。
 * - セッション未取得時は本ミドルウェアでは処理せず通過させる
 *   （呼び出し元の認証ミドルウェアが 401 を返す前提）。
 * - IdP 応答エラー時は fail-open: 監査ログだけ残して通過（IdP 一時的な 5xx で管理操作が
 *   全停止するのを避ける）。fail-closed が必要なら enforce=true と組み合わせて運用で判断する。
 * - 拒否時は 403 + `Secure-Session-Registration` ヘッダを付与し、Chrome の自動バインド動線を促す。
 */
export function requireDbscBoundSession(config: RequireDbscBoundConfig) {
  const logger = createLogger(config.loggerName);

  return createMiddleware<{ Bindings: BffEnv }>(async (c, next) => {
    // 副作用のないメソッドはスキップ
    if (SAFE_METHODS.has(c.req.method)) {
      return next();
    }

    const session = await parseSession(
      getCookie(c, config.sessionCookieName),
      c.env.SESSION_SECRET,
    );
    // セッションが無い場合は通過（別ミドルウェアで 401 を返す設計）
    if (!session) {
      return next();
    }

    const bound = await fetchDbscStatus(c.env, session.session_id, logger);

    // IdP 応答異常: fail-open で通過（障害時に管理操作が全停止しないように）
    if (bound === null) {
      return next();
    }

    if (bound) {
      // 正常に DBSC バインド済み
      return next();
    }

    // ここから先は未バインドセッション
    const enforce = isEnforceEnabled(config, c.env);
    if (!enforce) {
      logger.warn("[require-dbsc-bound] unbound session on sensitive route (warn-only mode)", {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        sessionId: session.session_id,
      });
      return next();
    }

    // enforce 有効: 403 + Secure-Session-Registration で Chrome に再バインド動線を案内
    logger.warn("[require-dbsc-bound] unbound session rejected", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      sessionId: session.session_id,
    });
    c.header(
      "Secure-Session-Registration",
      buildSecureSessionRegistrationHeader({ path: config.registrationPath }),
    );
    return c.json(
      {
        error: {
          code: "DBSC_BINDING_REQUIRED",
          message: "This operation requires a device-bound session",
        },
      },
      403,
    );
  });
}
