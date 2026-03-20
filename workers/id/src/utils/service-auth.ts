import { findServiceByClientId, sha256, timingSafeEqual } from '@0g0-id/shared';

/**
 * Basic認証でサービス認証を行い、サービス情報を返す。
 * 認証失敗時は null を返す。
 * DB障害・暗号処理エラーは throw して呼び出し元で 500 として扱う。
 */
export async function authenticateService(db: D1Database, authHeader: string | undefined) {
  if (!authHeader?.startsWith('Basic ')) return null;

  let credentials: string;
  try {
    credentials = atob(authHeader.slice(6));
  } catch {
    return null;
  }

  const colonIndex = credentials.indexOf(':');
  if (colonIndex === -1) return null;

  const clientId = credentials.slice(0, colonIndex);
  const clientSecret = credentials.slice(colonIndex + 1);

  try {
    const service = await findServiceByClientId(db, clientId);
    if (!service) return null;

    const secretHash = await sha256(clientSecret);
    if (!timingSafeEqual(secretHash, service.client_secret_hash)) return null;

    return service;
  } catch {
    // DB障害・暗号処理エラーは認証失敗として扱わず、呼び出し元で500を返す
    throw new Error('Service authentication failed due to internal error');
  }
}
