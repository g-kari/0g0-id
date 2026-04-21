/**
 * エラーレスポンス形式を統一するためのヘルパー。
 *
 * 本プロジェクトでは 2 種類のエラーレスポンス形式を使い分ける。
 *
 * 1. REST API 形式（`{ error: { code, message } }`）
 *    - `/api/users/*`, `/api/services/*`, `/api/metrics` 等のREST系エンドポイント
 *    - コードは大文字スネーク（`BAD_REQUEST` / `NOT_FOUND` 等）
 *
 * 2. OAuth 2.0 (RFC 6749) 形式（`{ error, error_description? }`）
 *    - `/api/token/*`, `/auth/authorize` 等の OAuth 系エンドポイント
 *    - コードは RFC 6749 準拠の小文字スネーク（`invalid_request` / `invalid_grant` 等）
 *
 * 仕様の詳細は `.claude/rules/api.md` を参照。
 */

/**
 * REST API で使用する標準エラーコード。
 * ルートごとに追加の固有コード（例: `TOKEN_ROTATED`, `INVALID_LINK_TOKEN`）を付けてよい。
 */
export const REST_ERROR_CODES = {
  BAD_REQUEST: "BAD_REQUEST",
  INVALID_PARAMETER: "INVALID_PARAMETER",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type RestErrorCode = (typeof REST_ERROR_CODES)[keyof typeof REST_ERROR_CODES];

/**
 * REST API エラーレスポンスのボディ。
 */
export interface RestErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/**
 * OAuth 2.0 (RFC 6749) 形式のエラーレスポンスボディ。
 */
export interface OAuthErrorBody {
  error: string;
  error_description?: string;
  error_uri?: string;
}

/**
 * REST API エラーボディを生成する。
 *
 * @example
 *   return c.json(restErrorBody("NOT_FOUND", "User not found"), 404);
 */
export function restErrorBody(code: string, message: string): RestErrorBody {
  return { error: { code, message } };
}

/**
 * OAuth 2.0 (RFC 6749) エラーボディを生成する。
 *
 * @example
 *   return c.json(oauthErrorBody("invalid_request", "client_id is required"), 400);
 */
export function oauthErrorBody(error: string, description?: string): OAuthErrorBody {
  return description === undefined ? { error } : { error, error_description: description };
}
