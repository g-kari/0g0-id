import { z } from 'zod';
import type { IdpEnv } from '@0g0-id/shared';

/**
 * 起動時に必須の環境変数を検証するスキーマ
 *
 * 必須: DB, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 *       JWT_PRIVATE_KEY, JWT_PUBLIC_KEY,
 *       IDP_ORIGIN, USER_ORIGIN, ADMIN_ORIGIN
 */
const envSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID は必須です'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET は必須です'),
  JWT_PRIVATE_KEY: z.string().min(1, 'JWT_PRIVATE_KEY は必須です'),
  JWT_PUBLIC_KEY: z.string().min(1, 'JWT_PUBLIC_KEY は必須です'),
  IDP_ORIGIN: z.url('IDP_ORIGIN は有効なURLである必要があります'),
  USER_ORIGIN: z.url('USER_ORIGIN は有効なURLである必要があります'),
  ADMIN_ORIGIN: z.url('ADMIN_ORIGIN は有効なURLである必要があります'),
});

type EnvValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/**
 * 環境変数を検証する。
 * @returns バリデーション結果。エラーの場合はエラーメッセージの配列を含む。
 */
export function validateEnv(env: IdpEnv): EnvValidationResult {
  const result = envSchema.safeParse(env);
  if (result.success) {
    return { ok: true };
  }
  const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  return { ok: false, errors };
}
