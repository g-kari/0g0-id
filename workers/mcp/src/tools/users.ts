import type { McpTool } from "../mcp";
import {
  listUsers,
  countUsers,
  banUserWithRevocation,
  unbanUser,
  deleteUser,
  updateUserRoleWithRevocation,
  getUserProviders,
  getLoginEventsByUserId,
  getUserLoginProviderStats,
  getUserDailyLoginTrends,
  listActiveSessionsByUserId,
  listServicesByOwner,
  listUserConnections,
  revokeUserTokens,
  deleteMcpSessionsByUser,
  createAdminAuditLog,
  type UserFilter,
} from "@0g0-id/shared";
import {
  requireString,
  isErrorResponse,
  errorResponse,
  jsonResponse,
  textResponse,
  requireUserValidation,
  isValidationError,
} from "./_helpers";

export const listUsersTool: McpTool = {
  definition: {
    name: "list_users",
    description: "ユーザー一覧を取得する（ページネーション・検索対応）",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "ページ番号（1始まり、デフォルト: 1）" },
        limit: { type: "number", description: "1ページあたりの件数（デフォルト: 50、最大: 100）" },
        search: { type: "string", description: "メールアドレスまたは名前で部分一致検索" },
        role: { type: "string", enum: ["user", "admin"], description: "ロールでフィルタ" },
      },
    },
  },
  handler: async (params, context) => {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 50));
    const offset = (page - 1) * limit;
    const search = typeof params.search === "string" ? params.search : undefined;
    const role = params.role === "user" || params.role === "admin" ? params.role : undefined;

    const filter: UserFilter = { role };
    if (search) {
      filter.search = search;
    }

    const [users, total] = await Promise.all([
      listUsers(context.db, limit, offset, filter),
      countUsers(context.db, filter),
    ]);

    const result = {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        banned_at: u.banned_at,
        created_at: u.created_at,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };

    return jsonResponse(result);
  },
};

export const getUserTool: McpTool = {
  definition: {
    name: "get_user",
    description: "指定ユーザーの詳細情報を取得する",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "ユーザーID" },
      },
      required: ["user_id"],
    },
  },
  handler: async (params, context) => {
    const validated = await requireUserValidation(params, context.db);
    if (isValidationError(validated)) return validated;
    const { user } = validated;

    return jsonResponse(user);
  },
};

export const banUserTool: McpTool = {
  definition: {
    name: "ban_user",
    description: "ユーザーをBANする",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "BANするユーザーのID" },
      },
      required: ["user_id"],
    },
  },
  handler: async (params, context) => {
    const validated = await requireUserValidation(params, context.db);
    if (isValidationError(validated)) return validated;
    const { userId } = validated;

    // BAN + 全トークン失効 + MCPセッション削除 を D1 batch() でアトミックに実行
    const user = await banUserWithRevocation(context.db, userId);
    await createAdminAuditLog(context.db, {
      adminUserId: context.userId,
      action: "user.ban",
      targetType: "user",
      targetId: userId,
    });
    return textResponse(
      `ユーザー ${user.name} (${user.email}) をBANしました。banned_at: ${user.banned_at}`,
    );
  },
};

export const unbanUserTool: McpTool = {
  definition: {
    name: "unban_user",
    description: "ユーザーのBANを解除する",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "BAN解除するユーザーのID" },
      },
      required: ["user_id"],
    },
  },
  handler: async (params, context) => {
    const validated = await requireUserValidation(params, context.db);
    if (isValidationError(validated)) return validated;
    const { userId } = validated;

    const user = await unbanUser(context.db, userId);
    await createAdminAuditLog(context.db, {
      adminUserId: context.userId,
      action: "user.unban",
      targetType: "user",
      targetId: userId,
    });
    return textResponse(`ユーザー ${user.name} (${user.email}) のBANを解除しました。`);
  },
};

export const deleteUserTool: McpTool = {
  definition: {
    name: "delete_user",
    description: "ユーザーを削除する（この操作は取り消せません）",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "削除するユーザーのID" },
      },
      required: ["user_id"],
    },
  },
  handler: async (params, context) => {
    const validated = await requireUserValidation(params, context.db);
    if (isValidationError(validated)) return validated;
    const { userId } = validated;

    await revokeUserTokens(context.db, userId, "security_event");
    await deleteMcpSessionsByUser(context.db, userId);

    const deleted = await deleteUser(context.db, userId);
    if (!deleted) {
      return errorResponse("ユーザーの削除に失敗しました");
    }

    await createAdminAuditLog(context.db, {
      adminUserId: context.userId,
      action: "user.delete",
      targetType: "user",
      targetId: userId,
    });

    return textResponse(`ユーザー ${userId} を削除しました。`);
  },
};

export const getUserLoginHistoryTool: McpTool = {
  definition: {
    name: "get_user_login_history",
    description: "ユーザーのログイン履歴を取得する",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "ユーザーID" },
        limit: { type: "number", description: "取得件数（デフォルト: 20、最大: 100）" },
      },
      required: ["user_id"],
    },
  },
  handler: async (params, context) => {
    const userId = requireString(params.user_id, "user_id");
    if (isErrorResponse(userId)) return userId;

    const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
    const result = await getLoginEventsByUserId(context.db, userId, limit);

    return jsonResponse(result);
  },
};

export const getUserLoginStatsTool: McpTool = {
  definition: {
    name: "get_user_login_stats",
    description: "ユーザーのプロバイダー別ログイン統計を取得する",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "ユーザーID" },
        days: { type: "number", description: "集計対象の日数（デフォルト: 30、最大: 365）" },
      },
      required: ["user_id"],
    },
  },
  handler: async (params, context) => {
    const validated = await requireUserValidation(params, context.db);
    if (isValidationError(validated)) return validated;
    const { userId } = validated;

    const days = Math.min(365, Math.max(1, Number(params.days) || 30));
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const stats = await getUserLoginProviderStats(context.db, userId, sinceIso);
    return jsonResponse({ stats, days });
  },
};

export const getUserLoginTrendsTool: McpTool = {
  definition: {
    name: "get_user_login_trends",
    description: "ユーザーの日別ログイントレンドを取得する",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "ユーザーID" },
        days: { type: "number", description: "集計対象の日数（デフォルト: 30、最大: 365）" },
      },
      required: ["user_id"],
    },
  },
  handler: async (params, context) => {
    const validated = await requireUserValidation(params, context.db);
    if (isValidationError(validated)) return validated;
    const { userId } = validated;

    const days = Math.min(365, Math.max(1, Number(params.days) || 30));

    const trends = await getUserDailyLoginTrends(context.db, userId, days);
    return jsonResponse({ trends, days });
  },
};
export const getUserProvidersTool: McpTool = {
  definition: {
    name: "get_user_providers",
    description: "ユーザーの連携済みプロバイダー一覧を取得する",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "ユーザーID" },
      },
      required: ["user_id"],
    },
  },
  handler: async (params, context) => {
    const userId = requireString(params.user_id, "user_id");
    if (isErrorResponse(userId)) return userId;

    const providers = await getUserProviders(context.db, userId);
    return jsonResponse(providers);
  },
};

export const listUserSessionsTool: McpTool = {
  definition: {
    name: "list_user_sessions",
    description:
      "ユーザーのアクティブセッション一覧を取得する（IdPセッション・サービストークン両方を含む）",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "ユーザーID" },
      },
      required: ["user_id"],
    },
  },
  handler: async (params, context) => {
    const validated = await requireUserValidation(params, context.db);
    if (isValidationError(validated)) return validated;
    const { userId, user } = validated;

    const sessions = await listActiveSessionsByUserId(context.db, userId);

    const result = {
      user: { id: user.id, email: user.email, name: user.name },
      sessions,
      total: sessions.length,
    };

    return jsonResponse(result);
  },
};

export const revokeUserSessionsTool: McpTool = {
  definition: {
    name: "revoke_user_sessions",
    description: "ユーザーの全アクティブセッションを失効させる（強制ログアウト）",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "セッションを失効させるユーザーのID" },
      },
      required: ["user_id"],
    },
  },
  handler: async (params, context) => {
    const validated = await requireUserValidation(params, context.db);
    if (isValidationError(validated)) return validated;
    const { userId, user } = validated;

    await revokeUserTokens(context.db, userId, "admin_action");
    await deleteMcpSessionsByUser(context.db, userId);

    await createAdminAuditLog(context.db, {
      adminUserId: context.userId,
      action: "user.sessions_revoked",
      targetType: "user",
      targetId: userId,
    });

    return textResponse(`ユーザー ${user.name} (${user.email}) の全セッションを失効させました。`);
  },
};

export const getUserOwnedServicesTool: McpTool = {
  definition: {
    name: "get_user_owned_services",
    description: "ユーザーが所有するサービス一覧を取得する（ユーザー削除前の所有権確認に使用）",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "ユーザーID" },
      },
      required: ["user_id"],
    },
  },
  handler: async (params, context) => {
    const validated = await requireUserValidation(params, context.db);
    if (isValidationError(validated)) return validated;
    const { userId, user } = validated;

    const services = await listServicesByOwner(context.db, userId);
    const result = {
      user: { id: user.id, email: user.email, name: user.name },
      owned_services: services.map((s) => ({
        id: s.id,
        name: s.name,
        client_id: s.client_id,
        allowed_scopes: s.allowed_scopes,
        created_at: s.created_at,
      })),
      total: services.length,
    };

    return jsonResponse(result);
  },
};

export const getUserAuthorizedServicesTool: McpTool = {
  definition: {
    name: "get_user_authorized_services",
    description: "ユーザーが認可済みのサービス（連携中のサービス）一覧を取得する",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "ユーザーID" },
      },
      required: ["user_id"],
    },
  },
  handler: async (params, context) => {
    const validated = await requireUserValidation(params, context.db);
    if (isValidationError(validated)) return validated;
    const { userId, user } = validated;

    const connections = await listUserConnections(context.db, userId);
    const result = {
      user: { id: user.id, email: user.email, name: user.name },
      authorized_services: connections,
      total: connections.length,
    };

    return jsonResponse(result);
  },
};

export const updateUserRoleTool: McpTool = {
  definition: {
    name: "update_user_role",
    description: "ユーザーのロールを変更する（user ↔ admin）",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "ロールを変更するユーザーのID" },
        role: {
          type: "string",
          enum: ["user", "admin"],
          description: '新しいロール（"user" または "admin"）',
        },
      },
      required: ["user_id", "role"],
    },
  },
  handler: async (params, context) => {
    const validated = await requireUserValidation(params, context.db);
    if (isValidationError(validated)) return validated;
    const { userId, user } = validated;

    const role = params.role;
    if (role !== "user" && role !== "admin") {
      return errorResponse('role は "user" または "admin" を指定してください');
    }

    if (user.role === role) {
      return textResponse(`ユーザー ${user.name} (${user.email}) のロールは既に "${role}" です`);
    }

    // ロール変更 + 全トークン失効 + MCPセッション削除 を D1 batch() でアトミックに実行
    // （権限変更を即座に反映するための既存セッション失効 — REST route と整合）
    const updated = await updateUserRoleWithRevocation(context.db, userId, role);

    await createAdminAuditLog(context.db, {
      adminUserId: context.userId,
      action: "user.role_change",
      targetType: "user",
      targetId: userId,
      details: { from: user.role, to: role },
    });

    const result = {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      updated_at: updated.updated_at,
    };

    return jsonResponse(result);
  },
};
