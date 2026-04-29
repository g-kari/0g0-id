import type { HonoRequest } from "hono";
import type { IdpEnv, User, Service } from "@0g0-id/shared";
import { findServiceByClientId, createLogger } from "@0g0-id/shared";
import { parseRequestBody } from "../../utils/body-parser";
import { authenticateService } from "../../utils/service-auth";

const tokenLogger = createLogger("token");

/**
 * `handleAuthorizationCodeGrant` / `handleRefreshTokenGrant` で共通利用するコンテキスト型。
 * Hono の Context から必要な最小インターフェースのみ抽出。
 */
export type TokenHandlerContext = {
  env: IdpEnv;
  req: { header: (name: string) => string | undefined };
  json: (data: unknown, status?: number, headers?: Record<string, string>) => Response;
  header: (name: string, value: string) => void;
};

/**
 * RFC 7009 / RFC 7662 準拠: リクエストボディのパース。
 * application/x-www-form-urlencoded（RFC標準）と application/json（後方互換）の両方に対応。
 * 共通の parseRequestBody を利用し、token 関連フィールドを抽出する。
 */
export async function parseTokenBody(
  req: HonoRequest,
): Promise<{ token?: string; token_type_hint?: string } | null> {
  const body = await parseRequestBody(req);
  if (!body) {
    tokenLogger.error("Failed to parse request body");
    return null;
  }
  return {
    token: typeof body["token"] === "string" ? body["token"] : undefined,
    token_type_hint:
      typeof body["token_type_hint"] === "string" ? body["token_type_hint"] : undefined,
  };
}

/**
 * スコープに基づいてイントロスペクションレスポンスへユーザークレームを付与する。
 * refresh_token / access_token の両ブランチで共通利用。
 */
export function applyUserClaims(
  claims: Record<string, unknown>,
  user: User,
  scopes: string[],
): void {
  if (scopes.includes("profile")) {
    claims["name"] = user.name;
    claims["picture"] = user.picture;
  }
  if (scopes.includes("email")) {
    claims["email"] = user.email;
    claims["email_verified"] = user.email_verified === 1;
  }
  if (scopes.includes("phone")) {
    claims["phone"] = user.phone;
  }
  if (scopes.includes("address")) {
    claims["address"] = user.address;
  }
}

/**
 * client_secret_basic 認証（Authorization: Basic）またはパブリッククライアント（none）を処理する。
 * Authorization ヘッダーがある場合は Basic 認証を検証し、クライアントIDの一致も確認する。
 * ヘッダーがない場合はパブリッククライアントとして bodyClientId のみで検証する。
 */
export async function resolveOAuthClient(
  db: D1Database,
  authHeader: string | undefined,
  bodyClientId: string | undefined,
): Promise<
  | {
      ok: true;
      service: Service;
      isPublicClient: boolean;
    }
  | { ok: false; error: string; status: 400 | 401 | 500 }
> {
  if (authHeader?.startsWith("Basic ")) {
    // Confidential client: client_secret_basic
    let service: Service | null;
    try {
      service = await authenticateService(db, authHeader);
    } catch (err) {
      tokenLogger.error("[resolveOAuthClient] Failed to authenticate service", err);
      return { ok: false, error: "server_error", status: 500 };
    }
    if (!service) {
      return { ok: false, error: "invalid_client", status: 401 };
    }
    // bodyのclient_idが指定されている場合、Basicヘッダーのclient_idと一致するか確認
    if (bodyClientId && bodyClientId !== service.client_id) {
      return { ok: false, error: "invalid_client", status: 401 };
    }
    return { ok: true, service, isPublicClient: false };
  }

  // Public client: client_id のみで識別（client_secret なし）
  if (!bodyClientId) {
    return { ok: false, error: "invalid_request", status: 400 };
  }
  let service: Service | null;
  try {
    service = await findServiceByClientId(db, bodyClientId);
  } catch (err) {
    tokenLogger.error("[resolveOAuthClient] Failed to find service by client_id", err);
    return { ok: false, error: "server_error", status: 500 };
  }
  if (!service) {
    return { ok: false, error: "invalid_client", status: 401 };
  }
  // confidentialクライアント（client_secret_hash設定済み）はBasic認証必須
  if (service.client_secret_hash) {
    return { ok: false, error: "invalid_client", status: 401 };
  }
  return { ok: true, service, isPublicClient: true };
}
