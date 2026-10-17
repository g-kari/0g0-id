import { createMiddleware } from "hono/factory";
import { findServiceByClientId, sha256, timingSafeEqual } from "@0g0-id/shared";
import type { IdpEnv, Service } from "@0g0-id/shared";

type ServiceVariables = { service: Service };

/**
 * Basic 認証ヘッダーをパースして clientId と clientSecret を返す。
 * ヘッダーが不正・存在しない場合は null を返す。
 */
export function parseBasicAuth(
  authHeader: string | undefined,
): { clientId: string; clientSecret: string } | null {
  if (!authHeader?.startsWith("Basic ")) return null;
  let credentials: string;
  try {
    credentials = atob(authHeader.slice(6));
  } catch {
    return null;
  }
  const colonIndex = credentials.indexOf(":");
  if (colonIndex <= 0 || colonIndex === credentials.length - 1) return null;
  return {
    clientId: credentials.slice(0, colonIndex),
    clientSecret: credentials.slice(colonIndex + 1),
  };
}

/**
 * Basic認証でサービス認証を行い、サービス情報を返す。
 * 認証失敗時は null を返す。
 * DB障害・暗号処理エラーは throw して呼び出し元で 500 として扱う。
 */
export async function authenticateService(db: D1Database, authHeader: string | undefined) {
  const parsed = parseBasicAuth(authHeader);
  if (!parsed) return null;
  const { clientId, clientSecret } = parsed;

  try {
    const service = await findServiceByClientId(db, clientId);
    if (!service) return null;

    const secretHash = await sha256(clientSecret);
    if (!timingSafeEqual(secretHash, service.client_secret_hash)) return null;

    return service;
  } catch {
    // DB障害・暗号処理エラーは認証失敗として扱わず、呼び出し元で500を返す
    throw new Error("Service authentication failed due to internal error");
  }
}

/**
 * 外部サービス向け認証ミドルウェア。
 * Basic 認証でサービスを認証し、context に service をセットする。
 * 認証失敗は 401、DB 障害は 500 を返す。
 */
export const serviceAuthMiddleware = createMiddleware<{
  Bindings: IdpEnv;
  Variables: ServiceVariables;
}>(async (c, next) => {
  let service: Service | null;
  try {
    service = await authenticateService(c.env.DB, c.req.header("Authorization"));
  } catch {
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
  if (!service) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid client credentials" } }, 401);
  }
  c.set("service", service);
  await next();
});
