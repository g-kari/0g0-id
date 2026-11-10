import type { Context } from "hono";
import type { IdpEnv, TokenPayload } from "@0g0-id/shared";
import { getReadyProviders } from "../../utils/auth-helpers";

type Variables = { user: TokenPayload };

/**
 * GET /auth/providers — 設定済みプロバイダーの一覧（真偽値のみ）
 *
 * フロント／BFF が未設定プロバイダーのログインボタンを表示しないために使う。
 * 判定基準は /auth/login の PROVIDER_NOT_CONFIGURED ゲートと同一。
 * 資格情報の値は一切含めないため、未認証で公開してよい。
 */
export async function handleProviders(c: Context<{ Bindings: IdpEnv; Variables: Variables }>) {
  c.header("Cache-Control", "no-store");
  return c.json({ data: await getReadyProviders(c.env) });
}
