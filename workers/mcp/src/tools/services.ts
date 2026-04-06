import type { McpTool } from '../mcp';
import {
  listServices,
  countServices,
  findServiceById,
  createService,
  deleteService,
  revokeAllServiceTokens,
  rotateClientSecret,
  generateClientId,
  generateClientSecret,
  sha256,
  createAdminAuditLog,
  type ServiceListFilter,
} from '@0g0-id/shared';

export const listServicesTool: McpTool = {
  definition: {
    name: 'list_services',
    description: 'サービス（OAuthクライアント）一覧を取得する（ページネーション・検索対応）',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'ページ番号（1始まり、デフォルト: 1）' },
        limit: { type: 'number', description: '1ページあたりの件数（デフォルト: 20、最大: 100）' },
        name: { type: 'string', description: 'サービス名で部分一致検索' },
      },
    },
  },
  handler: async (params, context) => {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
    const offset = (page - 1) * limit;
    const name = typeof params.name === 'string' ? params.name : undefined;

    const filter: ServiceListFilter = { limit, offset };
    if (name) {
      filter.name = name;
    }

    const [services, total] = await Promise.all([
      listServices(context.db, filter),
      countServices(context.db, { name }),
    ]);

    const result = {
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        client_id: s.client_id,
        allowed_scopes: s.allowed_scopes,
        owner_user_id: s.owner_user_id,
        created_at: s.created_at,
        updated_at: s.updated_at,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};

export const getServiceTool: McpTool = {
  definition: {
    name: 'get_service',
    description: 'サービス（OAuthクライアント）の詳細情報を取得する',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'サービスID' },
      },
      required: ['service_id'],
    },
  },
  handler: async (params, context) => {
    const serviceId = params.service_id;
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      return { content: [{ type: 'text', text: 'service_id は必須です' }], isError: true };
    }

    const service = await findServiceById(context.db, serviceId);
    if (!service) {
      return { content: [{ type: 'text', text: 'サービスが見つかりません' }], isError: true };
    }

    // client_secret_hash は返さない
    const result = {
      id: service.id,
      name: service.name,
      client_id: service.client_id,
      allowed_scopes: service.allowed_scopes,
      owner_user_id: service.owner_user_id,
      created_at: service.created_at,
      updated_at: service.updated_at,
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};

export const createServiceTool: McpTool = {
  definition: {
    name: 'create_service',
    description: '新規サービス（OAuthクライアント）を登録する。作成後にclient_idとclient_secretが返される（client_secretは再取得不可）',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'サービス名' },
        allowed_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: '許可するスコープの配列（デフォルト: ["openid", "profile", "email"]）',
        },
      },
      required: ['name'],
    },
  },
  handler: async (params, context) => {
    const name = params.name;
    if (typeof name !== 'string' || name.length === 0) {
      return { content: [{ type: 'text', text: 'name は必須です' }], isError: true };
    }

    // JSON.stringify で配列形式に統一（parseAllowedScopes がJSON配列を期待するため）
    const allowedScopes = Array.isArray(params.allowed_scopes)
      ? JSON.stringify(params.allowed_scopes as string[])
      : JSON.stringify(['openid', 'profile', 'email']);

    const id = crypto.randomUUID();
    const clientId = generateClientId();
    const clientSecret = generateClientSecret();
    const clientSecretHash = await sha256(clientSecret);

    const service = await createService(context.db, {
      id,
      name,
      clientId,
      clientSecretHash,
      allowedScopes,
      ownerUserId: context.userId,
    });

    await createAdminAuditLog(context.db, {
      adminUserId: context.userId,
      action: 'service.create',
      targetType: 'service',
      targetId: id,
      details: { name },
    });

    const result = {
      id: service.id,
      name: service.name,
      client_id: service.client_id,
      client_secret: clientSecret,
      allowed_scopes: service.allowed_scopes,
      owner_user_id: service.owner_user_id,
      created_at: service.created_at,
      updated_at: service.updated_at,
    };

    return {
      content: [
        {
          type: 'text',
          text: `サービスを作成しました。client_secret は以下のレスポンスのみで返却されます（再取得不可）。\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  },
};

export const deleteServiceTool: McpTool = {
  definition: {
    name: 'delete_service',
    description: 'サービスを削除する（この操作は取り消せません）',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: '削除するサービスのID' },
      },
      required: ['service_id'],
    },
  },
  handler: async (params, context) => {
    const serviceId = params.service_id;
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      return { content: [{ type: 'text', text: 'service_id は必須です' }], isError: true };
    }

    const service = await findServiceById(context.db, serviceId);
    if (!service) {
      return { content: [{ type: 'text', text: 'サービスが見つかりません' }], isError: true };
    }

    // サービス削除前に全ユーザーのアクティブトークンを失効させる（REST APIと同じ挙動）
    const revokedCount = await revokeAllServiceTokens(context.db, serviceId, 'service_delete');

    await deleteService(context.db, serviceId);

    await createAdminAuditLog(context.db, {
      adminUserId: context.userId,
      action: 'service.delete',
      targetType: 'service',
      targetId: serviceId,
      details: { name: service.name, revoked_token_count: revokedCount },
    });

    return {
      content: [
        {
          type: 'text',
          text: `サービス "${service.name}" (ID: ${serviceId}) を削除しました。${revokedCount > 0 ? `（アクティブトークン ${revokedCount} 件を失効）` : ''}`,
        },
      ],
    };
  },
};

export const rotateServiceSecretTool: McpTool = {
  definition: {
    name: 'rotate_service_secret',
    description: 'サービスのクライアントシークレットをローテーションする。新しいclient_secretが返される（再取得不可）',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'シークレットをローテーションするサービスのID' },
      },
      required: ['service_id'],
    },
  },
  handler: async (params, context) => {
    const serviceId = params.service_id;
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      return { content: [{ type: 'text', text: 'service_id は必須です' }], isError: true };
    }

    const service = await findServiceById(context.db, serviceId);
    if (!service) {
      return { content: [{ type: 'text', text: 'サービスが見つかりません' }], isError: true };
    }

    const newClientSecret = generateClientSecret();
    const newClientSecretHash = await sha256(newClientSecret);

    const updated = await rotateClientSecret(context.db, serviceId, newClientSecretHash);
    if (!updated) {
      return { content: [{ type: 'text', text: 'シークレットのローテーションに失敗しました' }], isError: true };
    }

    await createAdminAuditLog(context.db, {
      adminUserId: context.userId,
      action: 'service.secret_rotated',
      targetType: 'service',
      targetId: serviceId,
      details: { name: service.name },
    });

    const result = {
      id: updated.id,
      name: updated.name,
      client_id: updated.client_id,
      client_secret: newClientSecret,
      updated_at: updated.updated_at,
    };

    return {
      content: [
        {
          type: 'text',
          text: `シークレットをローテーションしました。新しい client_secret は以下のレスポンスのみで返却されます（再取得不可）。\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  },
};
