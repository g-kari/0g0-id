import type { McpTool } from "../mcp";
import { listAdminAuditLogs, getAuditLogStats, type AuditLogFilter } from "@0g0-id/shared";

export const getAuditLogsTool: McpTool = {
  definition: {
    name: "get_audit_logs",
    description: "管理者操作の監査ログを取得する（ページネーション・フィルタ対応）",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "ページ番号（1始まり、デフォルト: 1）" },
        limit: { type: "number", description: "1ページあたりの件数（デフォルト: 50、最大: 100）" },
        action: {
          type: "string",
          description: 'アクション名でフィルタ（例: "user.ban", "service.create"）',
        },
        admin_user_id: { type: "string", description: "操作した管理者のユーザーIDでフィルタ" },
        target_id: { type: "string", description: "操作対象のIDでフィルタ" },
        status: {
          type: "string",
          enum: ["success", "failure"],
          description: "ステータスでフィルタ",
        },
      },
    },
  },
  handler: async (params, context) => {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 50));
    const offset = (page - 1) * limit;

    const filters: AuditLogFilter = {};
    if (typeof params.action === "string" && params.action.length > 0) {
      filters.action = params.action;
    }
    if (typeof params.admin_user_id === "string" && params.admin_user_id.length > 0) {
      filters.adminUserId = params.admin_user_id;
    }
    if (typeof params.target_id === "string" && params.target_id.length > 0) {
      filters.targetId = params.target_id;
    }
    if (params.status === "success" || params.status === "failure") {
      filters.status = params.status;
    }

    const { logs, total } = await listAdminAuditLogs(context.db, limit, offset, filters);

    const result = {
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
};

export const getAuditStatsTool: McpTool = {
  definition: {
    name: "get_audit_stats",
    description: "監査ログの統計情報を取得する（アクション別・管理者別・日別集計）",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "日別集計の対象日数（デフォルト: 30）" },
      },
    },
  },
  handler: async (params, context) => {
    const days = Math.max(1, Math.min(365, Number(params.days) || 30));

    const stats = await getAuditLogStats(context.db, days);

    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
  },
};
