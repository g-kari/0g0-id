import type { Context } from "hono";
import { createAdminAuditLog, createLogger } from "@0g0-id/shared";
import type { IdpEnv, TokenPayload } from "@0g0-id/shared";
import { getClientIp } from "../utils/ip";

/**
 * 管理者監査ログのアクション種別。
 * 新しい操作を追加する場合は必ずここに追記すること（タイポ検出のため）。
 */
export type AuditAction =
  | "user.role_change"
  | "user.ban"
  | "user.unban"
  | "user.session_revoked"
  | "user.sessions_revoked"
  | "user.bff_session_revoked"
  | "user.delete"
  | "service.create"
  | "service.update"
  | "service.delete"
  | "service.redirect_uri_added"
  | "service.redirect_uri_deleted"
  | "service.secret_rotated"
  | "service.owner_transferred"
  | "service.user_access_revoked";

/** 監査ログ対象リソースの種別。 */
export type AuditTargetType = "user" | "service";

/** 監査ログ生成結果のステータス。 */
export type AuditStatus = "success" | "failure";

export interface AuditLogInput {
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  details?: Record<string, unknown> | null;
  /** 省略時は "success"。 */
  status?: AuditStatus;
}

/** Hono Context が `c.get("user")` で TokenPayload を返せることを要求する Env 制約。 */
type AuditEnv = { Bindings: IdpEnv; Variables: { user: TokenPayload } };

const auditLogger = createLogger("audit");

/**
 * 管理者監査ログを記録するヘルパー。
 *
 * - `adminUserId` は `c.get("user").sub`（JWT の sub）から自動抽出。
 * - `ipAddress` は `CF-Connecting-IP` ヘッダから自動抽出。
 * - 記録失敗は握り潰して `logger.error` に記録する（例外を上位に伝播させない）。
 *   → 呼び出し側は try/catch を書かずに `await logAdminAudit(c, {...})` するだけで良い。
 *
 * @param c Hono Context（`c.get("user")` で TokenPayload が取得可能なこと）
 * @param input action / targetType / targetId / details / status
 */
export async function logAdminAudit<E extends AuditEnv>(
  c: Context<E>,
  input: AuditLogInput,
): Promise<void> {
  const tokenUser = c.get("user");
  const ipAddress = getClientIp(c.req.raw);
  try {
    await createAdminAuditLog(c.env.DB, {
      adminUserId: tokenUser.sub,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      details: input.details ?? null,
      ipAddress,
      status: input.status ?? "success",
    });
  } catch (err) {
    auditLogger.error("Failed to create admin audit log", {
      err,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      status: input.status ?? "success",
    });
  }
}

/**
 * エラーオブジェクトから監査ログ詳細に含めるエラーメッセージを抽出する。
 * details に `{ error: extractErrorMessage(err) }` の形で混ぜる用途。
 */
export function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}
