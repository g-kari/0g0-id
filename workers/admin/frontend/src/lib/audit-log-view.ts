import { UUID_RE } from "../../../../../packages/shared/src/lib/validation";

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_ACTIONS = [
  "user.role_change",
  "user.ban",
  "user.unban",
  "user.session_revoked",
  "user.sessions_revoked",
  "user.bff_session_revoked",
  "user.delete",
  "user.lockout_clear",
  "service.create",
  "service.update",
  "service.delete",
  "service.redirect_uri_added",
  "service.redirect_uri_deleted",
  "service.secret_rotated",
  "service.owner_transferred",
  "service.user_access_revoked",
] as const;

export interface AuditQuery {
  adminUserId?: string;
  targetId?: string;
  action?: string;
  offset: number;
}

const ACTION_RE = /^[a-z]+\.[a-z_]+$/;
const QUERY_KEYS = new Set(["admin_user_id", "target_id", "action", "offset"]);

/** Fail closed: a malformed investigation must never become an unfiltered read. */
export function parseAuditQuery(params: URLSearchParams): AuditQuery | { error: string } {
  if (params.toString().length > 2048) return { error: "検索条件が長すぎます" };
  for (const key of params.keys()) {
    if (!QUERY_KEYS.has(key) || params.getAll(key).length !== 1) {
      return { error: "検索条件に未対応または重複した項目があります" };
    }
  }
  const adminUserId = params.get("admin_user_id") ?? undefined;
  const targetId = params.get("target_id") ?? undefined;
  if (adminUserId !== undefined && !UUID_RE.test(adminUserId)) {
    return { error: "操作者IDはUUID形式で入力してください" };
  }
  if (targetId !== undefined && !UUID_RE.test(targetId)) {
    return { error: "対象IDはUUID形式で入力してください" };
  }
  const action = params.get("action") ?? undefined;
  if (action !== undefined && (action.length > 128 || !ACTION_RE.test(action))) {
    return { error: "操作は user.ban のような小文字の分類.操作名で入力してください" };
  }
  const offsetRaw = params.get("offset");
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (
    (offsetRaw !== null && !/^\d{1,16}$/.test(offsetRaw)) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset % AUDIT_PAGE_SIZE !== 0
  )
    return { error: "ページの指定が不正です" };
  return { adminUserId, targetId, action, offset };
}

export function auditQueryParams(query: AuditQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.adminUserId !== undefined) params.set("admin_user_id", query.adminUserId);
  if (query.targetId !== undefined) params.set("target_id", query.targetId);
  if (query.action !== undefined) params.set("action", query.action);
  if (query.offset > 0) params.set("offset", String(query.offset));
  return params;
}

export interface AuditRow {
  createdAt: string;
  adminUserId: string;
  action: string;
  targetType: "user" | "service" | "other";
  targetId: string;
  status: "success" | "failure" | "unknown";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeId(value: unknown): string {
  return typeof value === "string" && UUID_RE.test(value) ? value : "ID形式不明";
}

function auditTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)
  )
    return "";
  // SQLite datetime('now') is UTC but has no suffix. Never interpret it as the viewer's local time.
  const normalized = value.replace(" ", "T");
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
  return Number.isNaN(Date.parse(zoned)) ? "" : zoned;
}

/** Project only allowlisted display fields; details, IPs and error messages are never retained. */
export function readAuditPage(
  value: unknown,
  query: AuditQuery,
): { rows: AuditRow[]; total: number } {
  if (!record(value) || !Array.isArray(value.data) || !record(value.pagination)) {
    throw new Error("invalid audit response");
  }
  const { total, limit, offset } = value.pagination;
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    limit !== AUDIT_PAGE_SIZE ||
    offset !== query.offset ||
    value.data.length > AUDIT_PAGE_SIZE ||
    value.data.length !== Math.min(AUDIT_PAGE_SIZE, Math.max(0, total - query.offset))
  )
    throw new Error("invalid audit pagination");
  const rows = value.data.map((item: unknown): AuditRow => {
    if (
      !record(item) ||
      (query.adminUserId !== undefined && item.admin_user_id !== query.adminUserId) ||
      (query.targetId !== undefined && item.target_id !== query.targetId) ||
      (query.action !== undefined && item.action !== query.action)
    )
      throw new Error("audit filters do not match");
    return {
      createdAt: auditTimestamp(item.created_at),
      adminUserId: safeId(item.admin_user_id),
      action:
        typeof item.action === "string" && item.action.length <= 128 && ACTION_RE.test(item.action)
          ? item.action
          : "不明な操作",
      targetType:
        item.target_type === "user" || item.target_type === "service" ? item.target_type : "other",
      targetId: safeId(item.target_id),
      status: item.status === "success" || item.status === "failure" ? item.status : "unknown",
    };
  });
  return { rows, total };
}

/** Existing detail routes only; never derive destinations from an API URL or target type. */
export function auditTargetHref(targetType: string, id: string): string | undefined {
  if (!UUID_RE.test(id)) return undefined;
  if (targetType === "user") return `/users/${encodeURIComponent(id.toLowerCase())}`;
  if (targetType === "service") return `/services/${encodeURIComponent(id.toLowerCase())}`;
  return undefined;
}
