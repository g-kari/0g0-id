import { createMiddleware } from "hono/factory";
import type { Context, HonoRequest } from "hono";
import type { IdpEnv, RateLimitBinding, TokenPayload } from "@0g0-id/shared";
import { createLogger } from "@0g0-id/shared";
import { getClientIp } from "../utils/ip";
import { parseBasicAuth } from "../utils/service-auth";

/**
 * バインディング未設定の警告を1isolateにつき1回だけ出力するための追跡Set。
 * Cloudflare Workers の同一isolateはリクエスト間でモジュールレベル状態を共有するが、
 * isolate再起動（コールドスタート）時はリセットされる。
 * wrangler.toml の設定漏れを本番デプロイ直後のログで即座に検知できる。
 */
const warnedBindings = new Set<string>();

const rateLimitLogger = createLogger("rate-limit");

/** Basic認証ヘッダーから client_id を抽出する。取得できない場合は null を返す */
function extractClientId(authHeader: string | undefined): string | null {
  return parseBasicAuth(authHeader)?.clientId ?? null;
}

/** リクエストボディから client_id を抽出する。取得できない場合は null を返す */
async function extractClientIdFromBody(req: HonoRequest): Promise<string | null> {
  const contentType = req.header("Content-Type") ?? "";
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const body = await req.parseBody();
      const clientId = body["client_id"];
      return typeof clientId === "string" ? clientId : null;
    } else if (contentType.includes("application/json")) {
      const body = await req.json<Record<string, unknown>>();
      return typeof body["client_id"] === "string" ? (body["client_id"] as string) : null;
    }
  } catch {
    return null;
  }
  return null;
}

type IdpContext = Context<{ Bindings: IdpEnv; Variables: { user?: TokenPayload } }>;

/**
 * レートリミットミドルウェアのファクトリ関数。
 * バインディングの取得・キー抽出・エラーメッセージを差し込むことで
 * 各エンドポイント向けのミドルウェアを生成する。
 *
 * バインディングが未設定の場合は最初のリクエスト時に1度だけ警告ログを出力し、
 * レートリミットをスキップする（ローカル開発・テスト時を想定）。
 * 本番環境でバインディング名を typo したままデプロイした場合でも
 * ログで即座に検知できる。
 *
 * @param retryAfterSeconds - RFC 6585 準拠の Retry-After ヘッダーに設定する待機秒数。
 *   wrangler.toml の rate_limit.period に合わせて設定すること（デフォルト: 60）。
 */
function createRateLimitMiddleware(
  bindingName: string,
  getBinding: (env: IdpEnv) => RateLimitBinding | undefined,
  getKey: (c: IdpContext) => string | Promise<string>,
  errorMessage: string,
  retryAfterSeconds = 60,
) {
  return createMiddleware<{ Bindings: IdpEnv; Variables: { user?: TokenPayload } }>(
    async (c, next) => {
      const binding = getBinding(c.env);
      if (!binding) {
        if (!warnedBindings.has(bindingName)) {
          warnedBindings.add(bindingName);
          // 本番環境（HTTPS）ではerrorレベルで即座にアラート検知可能にする
          const isProduction = c.env.IDP_ORIGIN?.startsWith("https://");
          const logFn = isProduction ? rateLimitLogger.error : rateLimitLogger.warn;
          logFn.call(
            rateLimitLogger,
            `[rate-limit] ${bindingName} binding is not configured — rate limiting is DISABLED.${isProduction ? " ⚠️ PRODUCTION: Configure this binding in wrangler.toml immediately." : " Configure this binding in wrangler.toml for production deployments."}`,
          );
        }
        return next();
      }
      const key = await getKey(c);
      // cf-connecting-ip が未設定（ローカル直接アクセス・Cloudflare設定ミス）の場合、
      // 全リクエストが 'unknown' キーに集約され、誤検知レートリミットが発生しうる。
      // 本番環境ではerrorレベルで即座にアラート検知可能にする。
      if (key === "unknown") {
        const isProduction = c.env.IDP_ORIGIN?.startsWith("https://");
        const logFn = isProduction ? rateLimitLogger.error : rateLimitLogger.warn;
        logFn.call(
          rateLimitLogger,
          `[rate-limit] ${bindingName}: rate limit key resolved to 'unknown' — cf-connecting-ip may not be set. All requests share the same bucket.${isProduction ? " ⚠️ PRODUCTION: Check Cloudflare proxy configuration." : ""}`,
        );
      }
      const { success } = await binding.limit({ key });
      if (!success) {
        return c.json(
          {
            error: {
              code: "TOO_MANY_REQUESTS",
              message: errorMessage,
            },
          },
          429,
          { "Retry-After": String(retryAfterSeconds) },
        );
      }
      await next();
    },
  );
}

/**
 * 認証フロー向けレートリミッター（IP単位）。
 * 対象: GET /auth/login, GET /auth/callback
 *
 * RATE_LIMITER_AUTH バインディングが未設定の場合はスキップ（ローカル開発・テスト時）。
 */
export const authRateLimitMiddleware = createRateLimitMiddleware(
  "RATE_LIMITER_AUTH",
  (env) => env.RATE_LIMITER_AUTH,
  (c) => getClientIp(c.req.raw) ?? "unknown",
  "Too many requests. Please try again later.",
);

/**
 * 外部サービス向けレートリミッター（client_id 単位）。
 * 対象: GET /api/external/*, POST /api/token/introspect
 *
 * client_id が取得できない場合は IP をキーとして使用する。
 * RATE_LIMITER_EXTERNAL バインディングが未設定の場合はスキップ。
 */
export const externalApiRateLimitMiddleware = createRateLimitMiddleware(
  "RATE_LIMITER_EXTERNAL",
  (env) => env.RATE_LIMITER_EXTERNAL,
  (c) => extractClientId(c.req.header("Authorization")) ?? getClientIp(c.req.raw) ?? "unknown",
  "Rate limit exceeded.",
);

/**
 * トークンエンドポイント向けレートリミッター（IP単位）。
 * 対象: POST /auth/exchange, POST /auth/refresh
 *
 * コード横取り・リフレッシュトークンブルートフォースを緩和する。
 * RATE_LIMITER_TOKEN バインディングが未設定の場合はスキップ（ローカル開発・テスト時）。
 */
export const tokenApiRateLimitMiddleware = createRateLimitMiddleware(
  "RATE_LIMITER_TOKEN",
  (env) => env.RATE_LIMITER_TOKEN,
  (c) => getClientIp(c.req.raw) ?? "unknown",
  "Too many requests. Please try again later.",
);

/**
 * トークンエンドポイント向けレートリミッター（client_id単位）。
 * 対象: POST /api/token
 *
 * IPローテーションによるブルートフォースを防ぐため、IP単位の tokenApiRateLimitMiddleware と
 * 併用する二重防御として使用する（RFC 6749 §10.10）。
 *
 * client_id の取得優先順:
 *   1. Authorization: Basic ヘッダー（コンフィデンシャルクライアント）
 *   2. リクエストボディの client_id フィールド（パブリッククライアント）
 *   3. IPアドレスにフォールバック
 *
 * RATE_LIMITER_TOKEN_CLIENT バインディングが未設定の場合はスキップ（ローカル開発・テスト時）。
 */
export const tokenApiClientRateLimitMiddleware = createRateLimitMiddleware(
  "RATE_LIMITER_TOKEN_CLIENT",
  (env) => env.RATE_LIMITER_TOKEN_CLIENT,
  async (c) => {
    // コンフィデンシャルクライアント: Authorization: Basic ヘッダーから client_id を取得
    const headerClientId = extractClientId(c.req.header("Authorization"));
    if (headerClientId) return headerClientId;
    // パブリッククライアント: ボディの client_id を取得（Honoはbodyをキャッシュするため二重読み取り安全）
    const bodyClientId = await extractClientIdFromBody(c.req);
    return bodyClientId ?? getClientIp(c.req.raw) ?? "unknown";
  },
  "Too many requests for this client. Please try again later.",
);

/**
 * デバイスコード検証向けレートリミッター（認証ユーザー単位）。
 * 対象: POST /api/device/verify
 *
 * user_code のブルートフォース推測を緩和する。authMiddleware の後に適用し、
 * 認証済みユーザーの sub をキーとして使用する。
 * RATE_LIMITER_DEVICE_VERIFY バインディングが未設定の場合はスキップ（ローカル開発・テスト時）。
 */
export const deviceVerifyRateLimitMiddleware = createRateLimitMiddleware(
  "RATE_LIMITER_DEVICE_VERIFY",
  (env) => env.RATE_LIMITER_DEVICE_VERIFY,
  (c) => {
    const user = c.get("user");
    return user?.sub ?? getClientIp(c.req.raw) ?? "unknown";
  },
  "Too many verification attempts. Please try again later.",
);
