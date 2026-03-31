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
    status?: 'success' | 'failure';
  }
): Promise<void> {
  const id = crypto.randomUUID();
  const status = data.status ?? 'success';
  await db
    .prepare(
      'INSERT INTO admin_audit_logs (id, admin_user_id, action, target_type, target_id, details, ip_address, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      id,
      data.adminUserId,
      data.action,
      data.targetType,
      data.targetId,
      data.details != null ? JSON.stringify(data.details) : null,
      data.ipAddress ?? null,
      status
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
    status?: 'success' | 'failure';
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
  if (filters?.status) {
    conditions.push('status = ?');
    params.push(filters.status);
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

export interface AuditLogStats {
  action_stats: Array<{ action: string; count: number }>;
  admin_stats: Array<{ admin_user_id: string; count: number }>;
  daily_stats: Array<{ date: string; count: number }>;
}

/**
 * 管理者操作の監査ログ統計を取得する。
 * アクション別・管理者別の全期間集計と、日別集計（直近N日）を返す。
 */
export async function getAuditLogStats(db: D1Database, days = 30): Promise<AuditLogStats> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [actionResult, adminResult, dailyResult] = await Promise.all([
    db
      .prepare(
        'SELECT action, COUNT(*) as count FROM admin_audit_logs GROUP BY action ORDER BY count DESC'
      )
      .all<{ action: string; count: number }>(),
    db
      .prepare(
        'SELECT admin_user_id, COUNT(*) as count FROM admin_audit_logs GROUP BY admin_user_id ORDER BY count DESC'
      )
      .all<{ admin_user_id: string; count: number }>(),
    db
      .prepare(
        "SELECT date(created_at) as date, COUNT(*) as count FROM admin_audit_logs WHERE created_at >= ? GROUP BY date(created_at) ORDER BY date DESC"
      )
      .bind(since)
      .all<{ date: string; count: number }>(),
  ]);

  return {
    action_stats: actionResult.results,
    admin_stats: adminResult.results,
    daily_stats: dailyResult.results,
  };
}
