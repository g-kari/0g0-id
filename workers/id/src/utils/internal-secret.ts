import type { IdpEnv } from "@0g0-id/shared";
import { timingSafeEqual } from "@0g0-id/shared";

export const INTERNAL_SECRET_HEADER = "X-Internal-Secret";

/**
 * X-Internal-Secret に一致したシークレットの種別。
 *
 * - `user` / `admin`: BFF 毎の個別シークレット（漏洩時の影響範囲を BFF 単位に限定）
 * - `shared`: 旧来の共有 INTERNAL_SERVICE_SECRET（後方互換のため残置。移行時に deprecation 警告対象）
 * - `none`: ヘッダー未設定、または設定済みシークレットのいずれとも一致しなかった
 */
export type InternalSecretKind = "user" | "admin" | "shared" | "none";

function candidates(
  env: IdpEnv,
): ReadonlyArray<{ kind: Exclude<InternalSecretKind, "none">; secret: string | undefined }> {
  return [
    { kind: "user", secret: env.INTERNAL_SERVICE_SECRET_USER },
    { kind: "admin", secret: env.INTERNAL_SERVICE_SECRET_ADMIN },
    { kind: "shared", secret: env.INTERNAL_SERVICE_SECRET },
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
 * - 個別シークレット（user/admin）→ 共有シークレット の順で照合し、最初に一致した種別を返す
 * - 一致判定は timingSafeEqual で、timing attack 耐性を確保
 *
 * 呼び出し側は戻り値を使って「BFF 毎の運用可観測性（どの BFF が呼び出したか）」や「共有シークレットの
 * 非推奨化 deprecation 警告」を出せる。
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
