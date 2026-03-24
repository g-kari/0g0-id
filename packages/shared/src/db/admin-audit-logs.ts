import type { AdminAuditLog } from '../types';

/**
 * 管理者操作の監査ログを記録する。
 * 操作に失敗した場合でもログが残らないよう、成功後に呼び出すこと。
 */
export async function createAdminAuditLog(
  db: D1Database,
  data: {
    adminUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    details?: Record<string, unknown> | null;
    ipAddress?: string | null;
  }
): Promise<void> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO admin_audit_logs (id, admin_user_id, action, target_type, target_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      id,
      data.adminUserId,
      data.action,
      data.targetType,
      data.targetId,
      data.details != null ? JSON.stringify(data.details) : null,
      data.ipAddress ?? null
    )
    .run();
}

/**
 * 管理者操作の監査ログを一覧取得する（降順）。
 * adminUserId・targetId・action でフィルタリング可能。
 */
export async function listAdminAuditLogs(
  db: D1Database,
  limit = 50,
  offset = 0,
  filters?: {
    adminUserId?: string;
    targetId?: string;
    action?: string;
  }
): Promise<{ logs: AdminAuditLog[]; total: number }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.adminUserId) {
    conditions.push('admin_user_id = ?');
    params.push(filters.adminUserId);
  }
  if (filters?.targetId) {
    conditions.push('target_id = ?');
    params.push(filters.targetId);
  }
  if (filters?.action) {
    conditions.push('action = ?');
    params.push(filters.action);
  }

  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

  const [logsResult, countResult] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM admin_audit_logs${whereClause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
      .all<AdminAuditLog>(),
    db
      .prepare(`SELECT COUNT(*) as count FROM admin_audit_logs${whereClause}`)
      .bind(...params)
      .first<{ count: number }>(),
  ]);

  return {
    logs: logsResult.results,
    total: countResult?.count ?? 0,
  };
}
