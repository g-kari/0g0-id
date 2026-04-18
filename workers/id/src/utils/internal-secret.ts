import type { IdpEnv } from "@0g0-id/shared";
import { timingSafeEqual } from "@0g0-id/shared";

export const INTERNAL_SECRET_HEADER = "X-Internal-Secret";

/**
 * 環境変数に設定されている内部シークレットの配列を返す（issue #156）。
 *
 * 優先順位や個別/共有の区別はここでは持たず、候補リストとして返すだけ。
 * 呼び出し側で `timingSafeEqual` を使って順次照合する。
 */
export function getConfiguredInternalSecrets(env: IdpEnv): string[] {
  return [
    env.INTERNAL_SERVICE_SECRET_USER,
    env.INTERNAL_SERVICE_SECRET_ADMIN,
    env.INTERNAL_SERVICE_SECRET,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
}

/**
 * リクエストの X-Internal-Secret ヘッダーが、設定済み内部シークレットのいずれかと一致するかを判定する。
 *
 * - ヘッダー未設定、もしくは設定シークレットが 0 件なら false
 * - 一致判定は timingSafeEqual で、timing attack 耐性を確保
 */
export function hasValidInternalSecret(env: IdpEnv, req: Request): boolean {
  const headerSecret = req.headers.get(INTERNAL_SECRET_HEADER);
  if (!headerSecret) return false;
  const secrets = getConfiguredInternalSecrets(env);
  for (const secret of secrets) {
    if (timingSafeEqual(headerSecret, secret)) return true;
  }
  return false;
}
