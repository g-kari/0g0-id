import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@0g0-id/shared', () => ({
  listServices: vi.fn(),
  countServices: vi.fn(),
  findServiceById: vi.fn(),
  createService: vi.fn(),
  deleteService: vi.fn(),
  revokeAllServiceTokens: vi.fn(),
  rotateClientSecret: vi.fn(),
  updateServiceFields: vi.fn(),
  listRedirectUris: vi.fn(),
  addRedirectUri: vi.fn(),
  findRedirectUriById: vi.fn(),
  deleteRedirectUri: vi.fn(),
  normalizeRedirectUri: vi.fn(),
  generateClientId: vi.fn(),
  generateClientSecret: vi.fn(),
  sha256: vi.fn(),
  createAdminAuditLog: vi.fn(),
}));

import {
  listServices,
  countServices,
  findServiceById,
  createService,
  deleteService,
  revokeAllServiceTokens,
  rotateClientSecret,
  updateServiceFields,
  listRedirectUris,
  addRedirectUri,
  findRedirectUriById,
  deleteRedirectUri,
  normalizeRedirectUri,
  generateClientId,
  generateClientSecret,
  sha256,
  createAdminAuditLog,
} from '@0g0-id/shared';

import {
  listServicesTool,
  getServiceTool,
  createServiceTool,
  updateServiceTool,
  deleteServiceTool,
  rotateServiceSecretTool,
  listRedirectUrisTool,
  addRedirectUriTool,
  deleteRedirectUriTool,
} from './services';
import type { McpContext } from '../mcp';

const mockContext: McpContext = {
  userId: 'admin-1',
  userRole: 'admin',
  db: {} as D1Database,
  idp: {} as Fetcher,
};

const mockService = {
  id: 'svc-1',
  name: 'Test Service',
  client_id: 'client-abc',
  client_secret_hash: 'hashed',
  allowed_scopes: 'openid profile email',
  owner_user_id: 'admin-1',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createAdminAuditLog).mockResolvedValue(undefined as never);
  vi.mocked(revokeAllServiceTokens).mockResolvedValue(0);
});

// ===== list_services =====
describe('listServicesTool', () => {
  it('デフォルトパラメータでサービス一覧を返す', async () => {
    vi.mocked(listServices).mockResolvedValue([mockService] as never);
    vi.mocked(countServices).mockResolvedValue(1);

    const result = await listServicesTool.handler({}, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.services).toHaveLength(1);
    expect(parsed.services[0].id).toBe('svc-1');
    // client_secret_hash は含まれない
    expect(parsed.services[0].client_secret_hash).toBeUndefined();
    expect(parsed.pagination.page).toBe(1);
    expect(parsed.pagination.limit).toBe(20);
  });

  it('pageとlimitを指定できる', async () => {
    vi.mocked(listServices).mockResolvedValue([]);
    vi.mocked(countServices).mockResolvedValue(100);

    const result = await listServicesTool.handler({ page: 2, limit: 10 }, mockContext);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pagination.page).toBe(2);
    expect(parsed.pagination.limit).toBe(10);
    expect(parsed.pagination.totalPages).toBe(10);
  });

  it('nameフィルターを渡せる', async () => {
    vi.mocked(listServices).mockResolvedValue([]);
    vi.mocked(countServices).mockResolvedValue(0);

    await listServicesTool.handler({ name: 'MyApp' }, mockContext);

    expect(vi.mocked(listServices)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({ name: 'MyApp' }),
    );
  });

  it('limitは100を超えない', async () => {
    vi.mocked(listServices).mockResolvedValue([]);
    vi.mocked(countServices).mockResolvedValue(0);

    await listServicesTool.handler({ limit: 200 }, mockContext);

    expect(vi.mocked(listServices)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({ limit: 100 }),
    );
  });
});

// ===== get_service =====
describe('getServiceTool', () => {
  it('サービスを返す（client_secret_hashは含まれない）', async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);

    const result = await getServiceTool.handler({ service_id: 'svc-1' }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('svc-1');
    expect(parsed.client_secret_hash).toBeUndefined();
  });

  it('service_id未指定はエラー', async () => {
    const result = await getServiceTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
  });

  it('サービスが見つからない場合はエラー', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);

    const result = await getServiceTool.handler({ service_id: 'nonexistent' }, mockContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('見つかりません');
  });
});

// ===== create_service =====
describe('createServiceTool', () => {
  it('サービスを作成しclient_secretを返す', async () => {
    vi.mocked(generateClientId).mockReturnValue('new-client-id');
    vi.mocked(generateClientSecret).mockReturnValue('new-secret');
    vi.mocked(sha256).mockResolvedValue('hashed-secret');
    vi.mocked(createService).mockResolvedValue(mockService as never);

    const result = await createServiceTool.handler({ name: 'New Service' }, mockContext);

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('new-secret');
    expect(text).toContain('再取得不可');
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        action: 'service.create',
        adminUserId: 'admin-1',
      }),
    );
  });

  it('allowed_scopesを配列で指定できる', async () => {
    vi.mocked(generateClientId).mockReturnValue('cid');
    vi.mocked(generateClientSecret).mockReturnValue('secret');
    vi.mocked(sha256).mockResolvedValue('hash');
    vi.mocked(createService).mockResolvedValue(mockService as never);

    await createServiceTool.handler(
      { name: 'Scoped Service', allowed_scopes: ['openid', 'email'] },
      mockContext,
    );

    expect(vi.mocked(createService)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({ allowedScopes: '["openid","email"]' }),
    );
  });

  it('allowed_scopes未指定時はデフォルトJSON配列形式で保存される', async () => {
    vi.mocked(generateClientId).mockReturnValue('cid');
    vi.mocked(generateClientSecret).mockReturnValue('secret');
    vi.mocked(sha256).mockResolvedValue('hash');
    vi.mocked(createService).mockResolvedValue(mockService as never);

    await createServiceTool.handler({ name: 'Default Service' }, mockContext);

    expect(vi.mocked(createService)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({ allowedScopes: '["openid","profile","email"]' }),
    );
  });

  it('name未指定はエラー', async () => {
    const result = await createServiceTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(createService)).not.toHaveBeenCalled();
  });

  it('nameが空文字はエラー', async () => {
    const result = await createServiceTool.handler({ name: '' }, mockContext);
    expect(result.isError).toBe(true);
  });
});

// ===== delete_service =====
describe('deleteServiceTool', () => {
  it('サービスを削除し監査ログを記録する', async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(deleteService).mockResolvedValue(undefined as never);

    const result = await deleteServiceTool.handler({ service_id: 'svc-1' }, mockContext);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('削除');
    // 削除前にトークンを失効させる
    expect(vi.mocked(revokeAllServiceTokens)).toHaveBeenCalledWith(
      mockContext.db,
      'svc-1',
      'service_delete',
    );
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        action: 'service.delete',
        targetId: 'svc-1',
        details: expect.objectContaining({ revoked_token_count: 0 }),
      }),
    );
  });

  it('アクティブトークンがある場合は失効件数をメッセージに含める', async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(deleteService).mockResolvedValue(undefined as never);
    vi.mocked(revokeAllServiceTokens).mockResolvedValue(5);

    const result = await deleteServiceTool.handler({ service_id: 'svc-1' }, mockContext);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('5 件を失効');
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        details: expect.objectContaining({ revoked_token_count: 5 }),
      }),
    );
  });

  it('service_id未指定はエラー', async () => {
    const result = await deleteServiceTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(deleteService)).not.toHaveBeenCalled();
    expect(vi.mocked(revokeAllServiceTokens)).not.toHaveBeenCalled();
  });

  it('サービスが見つからない場合はエラー', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);

    const result = await deleteServiceTool.handler({ service_id: 'nonexistent' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(deleteService)).not.toHaveBeenCalled();
    expect(vi.mocked(revokeAllServiceTokens)).not.toHaveBeenCalled();
  });
});

// ===== rotate_service_secret =====
describe('rotateServiceSecretTool', () => {
  it('シークレットをローテーションし新しいsecretを返す', async () => {
    const updatedService = { ...mockService, updated_at: '2024-06-01T00:00:00Z' };
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(generateClientSecret).mockReturnValue('new-rotated-secret');
    vi.mocked(sha256).mockResolvedValue('new-hash');
    vi.mocked(rotateClientSecret).mockResolvedValue(updatedService as never);

    const result = await rotateServiceSecretTool.handler({ service_id: 'svc-1' }, mockContext);

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('new-rotated-secret');
    expect(text).toContain('再取得不可');
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        action: 'service.secret_rotated',
        targetId: 'svc-1',
      }),
    );
  });

  it('service_id未指定はエラー', async () => {
    const result = await rotateServiceSecretTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
  });

  it('サービスが見つからない場合はエラー', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);

    const result = await rotateServiceSecretTool.handler({ service_id: 'nonexistent' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(rotateClientSecret)).not.toHaveBeenCalled();
  });

  it('ローテーション失敗時はエラー', async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(generateClientSecret).mockReturnValue('new-secret');
    vi.mocked(sha256).mockResolvedValue('new-hash');
    vi.mocked(rotateClientSecret).mockResolvedValue(null as never);

    const result = await rotateServiceSecretTool.handler({ service_id: 'svc-1' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(createAdminAuditLog)).not.toHaveBeenCalled();
  });
});

// ===== update_service =====
describe('updateServiceTool', () => {
  const updatedService = { ...mockService, name: 'Updated Name', updated_at: '2024-06-01T00:00:00Z' };

  it('nameを更新する', async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(updateServiceFields).mockResolvedValue(updatedService as never);

    const result = await updateServiceTool.handler({ service_id: 'svc-1', name: 'Updated Name' }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe('Updated Name');
    expect(vi.mocked(updateServiceFields)).toHaveBeenCalledWith(
      mockContext.db,
      'svc-1',
      expect.objectContaining({ name: 'Updated Name' }),
    );
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({ action: 'service.update', targetId: 'svc-1' }),
    );
  });

  it('allowed_scopesを更新する', async () => {
    const scopeUpdated = { ...mockService, allowed_scopes: '["openid","email"]' };
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(updateServiceFields).mockResolvedValue(scopeUpdated as never);

    const result = await updateServiceTool.handler(
      { service_id: 'svc-1', allowed_scopes: ['openid', 'email'] },
      mockContext,
    );

    expect(result.isError).toBeUndefined();
    expect(vi.mocked(updateServiceFields)).toHaveBeenCalledWith(
      mockContext.db,
      'svc-1',
      expect.objectContaining({ allowedScopes: '["openid","email"]' }),
    );
  });

  it('nameもallowed_scopesも未指定はエラー', async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);

    const result = await updateServiceTool.handler({ service_id: 'svc-1' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(updateServiceFields)).not.toHaveBeenCalled();
  });

  it('service_id未指定はエラー', async () => {
    const result = await updateServiceTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(updateServiceFields)).not.toHaveBeenCalled();
  });

  it('サービスが見つからない場合はエラー', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);

    const result = await updateServiceTool.handler({ service_id: 'nonexistent', name: 'X' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(updateServiceFields)).not.toHaveBeenCalled();
  });

  it('updateServiceFieldsがnullを返した場合はエラー', async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(updateServiceFields).mockResolvedValue(null as never);

    const result = await updateServiceTool.handler({ service_id: 'svc-1', name: 'X' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(createAdminAuditLog)).not.toHaveBeenCalled();
  });
});

// ===== list_redirect_uris =====
describe('listRedirectUrisTool', () => {
  const mockUri = {
    id: 'uri-1',
    service_id: 'svc-1',
    uri: 'https://example.com/callback',
    created_at: '2024-01-01T00:00:00Z',
  };

  it('リダイレクトURI一覧を返す', async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(listRedirectUris).mockResolvedValue([mockUri] as never);

    const result = await listRedirectUrisTool.handler({ service_id: 'svc-1' }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1);
    expect(parsed.redirect_uris).toHaveLength(1);
    expect(parsed.redirect_uris[0].id).toBe('uri-1');
    expect(parsed.service_name).toBe('Test Service');
    expect(vi.mocked(listRedirectUris)).toHaveBeenCalledWith(mockContext.db, 'svc-1');
  });

  it('URIがない場合は空配列を返す', async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(listRedirectUris).mockResolvedValue([]);

    const result = await listRedirectUrisTool.handler({ service_id: 'svc-1' }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(0);
    expect(parsed.redirect_uris).toHaveLength(0);
  });

  it('service_id未指定はエラー', async () => {
    const result = await listRedirectUrisTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(listRedirectUris)).not.toHaveBeenCalled();
  });

  it('サービスが見つからない場合はエラー', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);

    const result = await listRedirectUrisTool.handler({ service_id: 'nonexistent' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(listRedirectUris)).not.toHaveBeenCalled();
  });
});

// ===== add_redirect_uri =====
describe('addRedirectUriTool', () => {
  const mockUri = {
    id: 'uri-1',
    service_id: 'svc-1',
    uri: 'https://example.com/callback',
    created_at: '2024-01-01T00:00:00Z',
  };

  it('有効なURIを追加する', async () => {
    vi.mocked(normalizeRedirectUri).mockReturnValue('https://example.com/callback');
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(addRedirectUri).mockResolvedValue(mockUri as never);

    const result = await addRedirectUriTool.handler(
      { service_id: 'svc-1', uri: 'https://example.com/callback' },
      mockContext,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('uri-1');
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        action: 'service.redirect_uri_added',
        targetId: 'svc-1',
        details: { uri: 'https://example.com/callback' },
      }),
    );
  });

  it('無効なURI（normalizeRedirectUriがnullを返す）→ エラー', async () => {
    vi.mocked(normalizeRedirectUri).mockReturnValue(null);

    const result = await addRedirectUriTool.handler(
      { service_id: 'svc-1', uri: 'http://evil.com/callback' },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect(vi.mocked(addRedirectUri)).not.toHaveBeenCalled();
  });

  it('service_id未指定はエラー', async () => {
    const result = await addRedirectUriTool.handler({ uri: 'https://example.com/callback' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(addRedirectUri)).not.toHaveBeenCalled();
  });

  it('uri未指定はエラー', async () => {
    const result = await addRedirectUriTool.handler({ service_id: 'svc-1' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(addRedirectUri)).not.toHaveBeenCalled();
  });

  it('サービスが見つからない場合はエラー', async () => {
    vi.mocked(normalizeRedirectUri).mockReturnValue('https://example.com/callback');
    vi.mocked(findServiceById).mockResolvedValue(null);

    const result = await addRedirectUriTool.handler(
      { service_id: 'nonexistent', uri: 'https://example.com/callback' },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(vi.mocked(addRedirectUri)).not.toHaveBeenCalled();
  });
});

// ===== delete_redirect_uri =====
describe('deleteRedirectUriTool', () => {
  const mockUri = {
    id: 'uri-1',
    service_id: 'svc-1',
    uri: 'https://example.com/callback',
    created_at: '2024-01-01T00:00:00Z',
  };

  it('リダイレクトURIを削除し監査ログを記録する', async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(findRedirectUriById).mockResolvedValue(mockUri as never);
    vi.mocked(deleteRedirectUri).mockResolvedValue(1);

    const result = await deleteRedirectUriTool.handler(
      { service_id: 'svc-1', uri_id: 'uri-1' },
      mockContext,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('削除しました');
    expect(vi.mocked(deleteRedirectUri)).toHaveBeenCalledWith(mockContext.db, 'uri-1', 'svc-1');
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        action: 'service.redirect_uri_deleted',
        targetId: 'svc-1',
        details: { uri: 'https://example.com/callback' },
      }),
    );
  });

  it('service_id未指定はエラー', async () => {
    const result = await deleteRedirectUriTool.handler({ uri_id: 'uri-1' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(deleteRedirectUri)).not.toHaveBeenCalled();
  });

  it('uri_id未指定はエラー', async () => {
    const result = await deleteRedirectUriTool.handler({ service_id: 'svc-1' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(deleteRedirectUri)).not.toHaveBeenCalled();
  });

  it('サービスが見つからない場合はエラー', async () => {
    vi.mocked(findServiceById).mockResolvedValue(null);

    const result = await deleteRedirectUriTool.handler(
      { service_id: 'nonexistent', uri_id: 'uri-1' },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(vi.mocked(deleteRedirectUri)).not.toHaveBeenCalled();
  });

  it('リダイレクトURIが見つからない場合はエラー', async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(findRedirectUriById).mockResolvedValue(null);

    const result = await deleteRedirectUriTool.handler(
      { service_id: 'svc-1', uri_id: 'nonexistent' },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(vi.mocked(deleteRedirectUri)).not.toHaveBeenCalled();
    expect(vi.mocked(createAdminAuditLog)).not.toHaveBeenCalled();
  });

  it('deleteRedirectUriが0件を返した場合はエラー', async () => {
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(findRedirectUriById).mockResolvedValue(mockUri as never);
    vi.mocked(deleteRedirectUri).mockResolvedValue(0);

    const result = await deleteRedirectUriTool.handler(
      { service_id: 'svc-1', uri_id: 'uri-1' },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(vi.mocked(createAdminAuditLog)).not.toHaveBeenCalled();
  });
});
