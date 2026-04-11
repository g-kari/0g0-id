import type { McpTool } from '../mcp';
import {
  listServices,
  countServices,
  findServiceById,
  findUserById,
  createService,
  deleteService,
  revokeAllServiceTokens,
  revokeUserServiceTokens,
  rotateClientSecret,
  updateServiceFields,
  listRedirectUris,
  addRedirectUri,
  findRedirectUriById,
  deleteRedirectUri,
  normalizeRedirectUri,
  listUsersAuthorizedForService,
  countUsersAuthorizedForService,
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

export const updateServiceTool: McpTool = {
  definition: {
    name: 'update_service',
    description: 'サービスの名前または許可スコープを更新する',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'サービスID' },
        name: { type: 'string', description: '新しいサービス名（省略可）' },
        allowed_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: '許可するスコープの配列（省略可）。例: ["openid", "profile", "email"]',
        },
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

    const name = typeof params.name === 'string' && params.name.length > 0 ? params.name : undefined;
    const allowedScopes = Array.isArray(params.allowed_scopes)
      ? JSON.stringify(params.allowed_scopes as string[])
      : undefined;

    if (!name && !allowedScopes) {
      return {
        content: [{ type: 'text', text: 'name または allowed_scopes のいずれかを指定してください' }],
        isError: true,
      };
    }

    const updated = await updateServiceFields(context.db, serviceId, {
      ...(name ? { name } : {}),
      ...(allowedScopes ? { allowedScopes } : {}),
    });

    if (!updated) {
      return { content: [{ type: 'text', text: 'サービスの更新に失敗しました' }], isError: true };
    }

    await createAdminAuditLog(context.db, {
      adminUserId: context.userId,
      action: 'service.update',
      targetType: 'service',
      targetId: serviceId,
      details: {
        ...(name ? { name } : {}),
        ...(params.allowed_scopes ? { allowed_scopes: params.allowed_scopes } : {}),
      },
    });

    const result = {
      id: updated.id,
      name: updated.name,
      client_id: updated.client_id,
      allowed_scopes: updated.allowed_scopes,
      owner_user_id: updated.owner_user_id,
      updated_at: updated.updated_at,
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};

export const listRedirectUrisTool: McpTool = {
  definition: {
    name: 'list_redirect_uris',
    description: 'サービスに登録されているリダイレクトURIの一覧を取得する',
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

    const uris = await listRedirectUris(context.db, serviceId);
    const result = {
      service_id: serviceId,
      service_name: service.name,
      redirect_uris: uris,
      total: uris.length,
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};

export const addRedirectUriTool: McpTool = {
  definition: {
    name: 'add_redirect_uri',
    description: 'サービスにリダイレクトURIを追加する（https必須、localhostのみhttp可、フラグメント禁止）',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'サービスID' },
        uri: { type: 'string', description: '追加するリダイレクトURI' },
      },
      required: ['service_id', 'uri'],
    },
  },
  handler: async (params, context) => {
    const serviceId = params.service_id;
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      return { content: [{ type: 'text', text: 'service_id は必須です' }], isError: true };
    }

    const uri = params.uri;
    if (typeof uri !== 'string' || uri.length === 0) {
      return { content: [{ type: 'text', text: 'uri は必須です' }], isError: true };
    }

    const normalized = normalizeRedirectUri(uri);
    if (!normalized) {
      return {
        content: [{ type: 'text', text: '無効なリダイレクトURIです（https必須、フラグメント禁止、localhostのみhttp可）' }],
        isError: true,
      };
    }

    const service = await findServiceById(context.db, serviceId);
    if (!service) {
      return { content: [{ type: 'text', text: 'サービスが見つかりません' }], isError: true };
    }

    let added;
    try {
      added = await addRedirectUri(context.db, {
        id: crypto.randomUUID(),
        serviceId,
        uri: normalized,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        return { content: [{ type: 'text', text: 'そのリダイレクトURIは既に登録されています' }], isError: true };
      }
      throw err;
    }

    await createAdminAuditLog(context.db, {
      adminUserId: context.userId,
      action: 'service.redirect_uri_added',
      targetType: 'service',
      targetId: serviceId,
      details: { uri: normalized },
    });

    return { content: [{ type: 'text', text: JSON.stringify(added, null, 2) }] };
  },
};

export const deleteRedirectUriTool: McpTool = {
  definition: {
    name: 'delete_redirect_uri',
    description: 'サービスからリダイレクトURIを削除する',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'サービスID' },
        uri_id: { type: 'string', description: '削除するリダイレクトURIのID' },
      },
      required: ['service_id', 'uri_id'],
    },
  },
  handler: async (params, context) => {
    const serviceId = params.service_id;
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      return { content: [{ type: 'text', text: 'service_id は必須です' }], isError: true };
    }

    const uriId = params.uri_id;
    if (typeof uriId !== 'string' || uriId.length === 0) {
      return { content: [{ type: 'text', text: 'uri_id は必須です' }], isError: true };
    }

    const service = await findServiceById(context.db, serviceId);
    if (!service) {
      return { content: [{ type: 'text', text: 'サービスが見つかりません' }], isError: true };
    }

    const existing = await findRedirectUriById(context.db, uriId, serviceId);
    if (!existing) {
      return { content: [{ type: 'text', text: 'リダイレクトURIが見つかりません' }], isError: true };
    }

    const changes = await deleteRedirectUri(context.db, uriId, serviceId);
    if (changes === 0) {
      return { content: [{ type: 'text', text: 'リダイレクトURIの削除に失敗しました' }], isError: true };
    }

    await createAdminAuditLog(context.db, {
      adminUserId: context.userId,
      action: 'service.redirect_uri_deleted',
      targetType: 'service',
      targetId: serviceId,
      details: { uri: existing.uri },
    });

    return {
      content: [{ type: 'text', text: `リダイレクトURI "${existing.uri}" を削除しました。` }],
    };
  },
};

export const listServiceUsersTool: McpTool = {
  definition: {
    name: 'list_service_users',
    description: 'サービスを認可済みのユーザー一覧を取得する（ページネーション対応）',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'サービスID' },
        page: { type: 'number', description: 'ページ番号（1始まり、デフォルト: 1）' },
        limit: { type: 'number', description: '1ページあたりの件数（デフォルト: 50、最大: 100）' },
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

    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 50));
    const offset = (page - 1) * limit;

    const [users, total] = await Promise.all([
      listUsersAuthorizedForService(context.db, serviceId, limit, offset),
      countUsersAuthorizedForService(context.db, serviceId),
    ]);

    const result = {
      service: { id: service.id, name: service.name },
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        created_at: u.created_at,
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

export const revokeServiceUserAccessTool: McpTool = {
  definition: {
    name: 'revoke_service_user_access',
    description: '指定ユーザーの特定サービスへのアクセスを失効させる（そのサービスのトークンのみ失効）',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'サービスID' },
        user_id: { type: 'string', description: 'アクセスを失効させるユーザーのID' },
      },
      required: ['service_id', 'user_id'],
    },
  },
  handler: async (params, context) => {
    const serviceId = params.service_id;
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      return { content: [{ type: 'text', text: 'service_id は必須です' }], isError: true };
    }

    const userId = params.user_id;
    if (typeof userId !== 'string' || userId.length === 0) {
      return { content: [{ type: 'text', text: 'user_id は必須です' }], isError: true };
    }

    const [service, user] = await Promise.all([
      findServiceById(context.db, serviceId),
      findUserById(context.db, userId),
    ]);

    if (!service) {
      return { content: [{ type: 'text', text: 'サービスが見つかりません' }], isError: true };
    }
    if (!user) {
      return { content: [{ type: 'text', text: 'ユーザーが見つかりません' }], isError: true };
    }

    const revokedCount = await revokeUserServiceTokens(context.db, userId, serviceId, 'admin_action');
    if (revokedCount === 0) {
      return {
        content: [{ type: 'text', text: `ユーザー ${user.name} (${user.email}) はサービス "${service.name}" へのアクティブなトークンを持っていません（既に失効済みまたは未認可）` }],
      };
    }

    await createAdminAuditLog(context.db, {
      adminUserId: context.userId,
      action: 'service.user_access_revoked',
      targetType: 'service',
      targetId: serviceId,
      details: { user_id: userId, revoked_token_count: revokedCount },
    });

    return {
      content: [
        {
          type: 'text',
          text: `ユーザー ${user.name} (${user.email}) のサービス "${service.name}" へのアクセスを失効させました。（トークン ${revokedCount} 件を失効）`,
        },
      ],
    };
  },
};
