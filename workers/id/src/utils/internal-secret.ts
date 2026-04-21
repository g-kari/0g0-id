import type { IdpEnv } from "@0g0-id/shared";
import { timingSafeEqual } from "@0g0-id/shared";

export const INTERNAL_SECRET_HEADER = "X-Internal-Secret";

/**
 * X-Internal-Secret に一致したシークレットの種別。
 *
 * - `user` / `admin`: BFF 毎の個別シークレット（漏洩時の影響範囲を BFF 単位に限定）
 * - `none`: ヘッダー未設定、または設定済みシークレットのいずれとも一致しなかった
 */
export type InternalSecretKind = "user" | "admin" | "none";

function candidates(
  env: IdpEnv,
): ReadonlyArray<{ kind: Exclude<InternalSecretKind, "none">; secret: string | undefined }> {
  return [
    { kind: "user", secret: env.INTERNAL_SERVICE_SECRET_USER },
    { kind: "admin", secret: env.INTERNAL_SERVICE_SECRET_ADMIN },
  ];
}

export function getConfiguredInternalSecrets(env: IdpEnv): string[] {
  return candidates(env)
    .map((c) => c.secret)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
}

/**
 * リクエストの X-Internal-Secret ヘッダーが、設定済み内部シークレットのいずれに一致したかを分類する。
 *
 * - ヘッダー未設定、もしくは設定シークレットが 0 件なら "none"
 * - 個別シークレット（user/admin）を順に照合し、最初に一致した種別を返す
 * - 一致判定は timingSafeEqual で、timing attack 耐性を確保
 */
export function classifyInternalSecret(env: IdpEnv, req: Request): InternalSecretKind {
  const headerSecret = req.headers.get(INTERNAL_SECRET_HEADER);
  if (!headerSecret) return "none";
  for (const { kind, secret } of candidates(env)) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    if (timingSafeEqual(headerSecret, secret)) return kind;
  }
  return "none";
}

export function hasValidInternalSecret(env: IdpEnv, req: Request): boolean {
  return classifyInternalSecret(env, req) !== "none";
}
