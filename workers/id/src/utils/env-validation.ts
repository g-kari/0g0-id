import { z } from "zod";
import type { IdpEnv } from "@0g0-id/shared";

/**
 * 起動時に必須の環境変数を検証するスキーマ
 *
 * 必須: DB, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 *       JWT_PRIVATE_KEY, JWT_PUBLIC_KEY,
 *       IDP_ORIGIN, USER_ORIGIN, ADMIN_ORIGIN,
 *       COOKIE_SECRET（state cookie の HMAC-SHA256 署名用）
 *
 * オプション: LINE/Twitch/GitHub/X の CLIENT_ID と CLIENT_SECRET は
 *             両方設定するか、両方未設定にすること（片方だけは不可）
 */
const envSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID は必須です"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET は必須です"),
  JWT_PRIVATE_KEY: z.string().min(1, "JWT_PRIVATE_KEY は必須です"),
  JWT_PUBLIC_KEY: z.string().min(1, "JWT_PUBLIC_KEY は必須です"),
  IDP_ORIGIN: z.url("IDP_ORIGIN は有効なURLである必要があります"),
  USER_ORIGIN: z.url("USER_ORIGIN は有効なURLである必要があります"),
  ADMIN_ORIGIN: z.url("ADMIN_ORIGIN は有効なURLである必要があります"),
  COOKIE_SECRET: z.string().min(32, "COOKIE_SECRET は32文字以上の安全なランダム値が必要です"),
});

type EnvValidationResult = { ok: true } | { ok: false; errors: string[] };

/**
 * 環境変数を検証する。
 * Cloudflare Workers の同一isolate内では環境変数は不変のため、
 * 初回検証結果をキャッシュして以降のリクエストではスキップする。
 * @returns バリデーション結果。エラーの場合はエラーメッセージの配列を含む。
 */
let cachedResult: EnvValidationResult | null = null;

/** @internal テスト用: キャッシュをリセットする */
export function _resetValidationCache(): void {
  cachedResult = null;
}

export function validateEnv(env: IdpEnv): EnvValidationResult {
  if (cachedResult !== null) return cachedResult;
  const result = envSchema.safeParse(env);
  const errors: string[] = result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);

  // オプションプロバイダーの認証情報は片方だけ設定されていてはならない（設定ミスの早期検知）
  const optionalProviderPairs = [
    { id: "LINE_CLIENT_ID" as const, secret: "LINE_CLIENT_SECRET" as const, name: "LINE" },
    { id: "TWITCH_CLIENT_ID" as const, secret: "TWITCH_CLIENT_SECRET" as const, name: "Twitch" },
    { id: "GITHUB_CLIENT_ID" as const, secret: "GITHUB_CLIENT_SECRET" as const, name: "GitHub" },
    { id: "X_CLIENT_ID" as const, secret: "X_CLIENT_SECRET" as const, name: "X" },
  ];

  for (const pair of optionalProviderPairs) {
    const hasId = !!env[pair.id];
    const hasSecret = !!env[pair.secret];
    if (hasId !== hasSecret) {
      const missing = hasId ? pair.secret : pair.id;
      errors.push(`${missing}: ${pair.name} の CLIENT_ID と CLIENT_SECRET は両方設定してください`);
    }
  }

  // 本番環境ではレートリミッターの binding 未設定を警告（起動は止めない）
  const isProduction = env.IDP_ORIGIN?.startsWith("https://") ?? false;
  if (isProduction) {
    const rateLimiterBindings = [
      "RATE_LIMITER_AUTH",
      "RATE_LIMITER_EXTERNAL",
      "RATE_LIMITER_TOKEN",
      "RATE_LIMITER_TOKEN_CLIENT",
      "RATE_LIMITER_DEVICE_VERIFY",
    ] as const;
    for (const bindingName of rateLimiterBindings) {
      if (!env[bindingName]) {
        console.warn(`${bindingName}: 本番環境ではレートリミッターの binding 設定が必要です`);
      }
    }
  }

  if (errors.length > 0) {
    // 検証失敗時はキャッシュしない（環境変数修正後にisolate再起動なしで回復できるようにする）
    return { ok: false, errors };
  }
  cachedResult = { ok: true };
  return cachedResult;
}
