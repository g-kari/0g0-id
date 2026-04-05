import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@0g0-id/shared', () => ({
  listUsers: vi.fn(),
  countUsers: vi.fn(),
  findUserById: vi.fn(),
  banUser: vi.fn(),
  unbanUser: vi.fn(),
  deleteUser: vi.fn(),
  getUserProviders: vi.fn(),
  getLoginEventsByUserId: vi.fn(),
  createAdminAuditLog: vi.fn(),
}));

import {
  listUsers,
  countUsers,
  findUserById,
  banUser,
  unbanUser,
  deleteUser,
  getUserProviders,
  getLoginEventsByUserId,
  createAdminAuditLog,
} from '@0g0-id/shared';

import {
  listUsersTool,
  getUserTool,
  banUserTool,
  unbanUserTool,
  deleteUserTool,
  getUserLoginHistoryTool,
  getUserProvidersTool,
} from './users';
import type { McpContext } from '../mcp';

const mockContext: McpContext = {
  userId: 'admin-1',
  userRole: 'admin',
  db: {} as D1Database,
  idp: {} as Fetcher,
};

const mockUser = {
  id: 'user-1',
  google_sub: 'google-sub-1',
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: 'test@example.com',
  email_verified: 1,
  name: 'Test User',
  picture: null,
  phone: null,
  address: null,
  role: 'user' as const,
  banned_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createAdminAuditLog).mockResolvedValue(undefined as never);
});

// ===== list_users =====
describe('listUsersTool', () => {
  it('デフォルトパラメータでユーザー一覧を返す', async () => {
    vi.mocked(listUsers).mockResolvedValue([mockUser] as never);
    vi.mocked(countUsers).mockResolvedValue(1);

    const result = await listUsersTool.handler({}, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pagination.page).toBe(1);
    expect(parsed.pagination.limit).toBe(50);
    expect(parsed.pagination.total).toBe(1);
    expect(parsed.users).toHaveLength(1);
    expect(parsed.users[0].id).toBe('user-1');
  });

  it('pageとlimitを指定できる', async () => {
    vi.mocked(listUsers).mockResolvedValue([]);
    vi.mocked(countUsers).mockResolvedValue(200);

    const result = await listUsersTool.handler({ page: 3, limit: 10 }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pagination.page).toBe(3);
    expect(parsed.pagination.limit).toBe(10);
    expect(parsed.pagination.totalPages).toBe(20);
  });

  it('limitは100を超えないよう丸める', async () => {
    vi.mocked(listUsers).mockResolvedValue([]);
    vi.mocked(countUsers).mockResolvedValue(0);

    await listUsersTool.handler({ limit: 999 }, mockContext);

    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(
      mockContext.db,
      100,
      expect.any(Number),
      expect.any(Object),
    );
  });

  it('roleフィルターを渡せる', async () => {
    vi.mocked(listUsers).mockResolvedValue([]);
    vi.mocked(countUsers).mockResolvedValue(0);

    await listUsersTool.handler({ role: 'admin' }, mockContext);

    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(
      mockContext.db,
      50,
      0,
      expect.objectContaining({ role: 'admin' }),
    );
  });

  it('無効なroleは無視する', async () => {
    vi.mocked(listUsers).mockResolvedValue([]);
    vi.mocked(countUsers).mockResolvedValue(0);

    await listUsersTool.handler({ role: 'superuser' }, mockContext);

    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(
      mockContext.db,
      50,
      0,
      expect.objectContaining({ role: undefined }),
    );
  });
});

// ===== get_user =====
describe('getUserTool', () => {
  it('ユーザーを返す', async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);

    const result = await getUserTool.handler({ user_id: 'user-1' }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('user-1');
  });

  it('user_id未指定はエラー', async () => {
    const result = await getUserTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
  });

  it('user_idが空文字はエラー', async () => {
    const result = await getUserTool.handler({ user_id: '' }, mockContext);
    expect(result.isError).toBe(true);
  });

  it('ユーザーが見つからない場合はエラー', async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await getUserTool.handler({ user_id: 'nonexistent' }, mockContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('見つかりません');
  });
});

// ===== ban_user =====
describe('banUserTool', () => {
  it('ユーザーをBANし監査ログを記録する', async () => {
    const bannedUser = { ...mockUser, banned_at: '2024-06-01T00:00:00Z' };
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(banUser).mockResolvedValue(bannedUser as never);

    const result = await banUserTool.handler({ user_id: 'user-1' }, mockContext);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('BAN');
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        adminUserId: 'admin-1',
        action: 'user.ban',
        targetId: 'user-1',
      }),
    );
  });

  it('user_id未指定はエラー', async () => {
    const result = await banUserTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
  });

  it('ユーザーが見つからない場合はエラー', async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await banUserTool.handler({ user_id: 'nonexistent' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(banUser)).not.toHaveBeenCalled();
  });
});

// ===== unban_user =====
describe('unbanUserTool', () => {
  it('ユーザーのBANを解除し監査ログを記録する', async () => {
    vi.mocked(findUserById).mockResolvedValue({ ...mockUser, banned_at: '2024-06-01T00:00:00Z' });
    vi.mocked(unbanUser).mockResolvedValue(mockUser as never);

    const result = await unbanUserTool.handler({ user_id: 'user-1' }, mockContext);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('BANを解除');
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        action: 'user.unban',
        targetId: 'user-1',
      }),
    );
  });

  it('ユーザーが見つからない場合はエラー', async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await unbanUserTool.handler({ user_id: 'nonexistent' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(unbanUser)).not.toHaveBeenCalled();
  });
});

// ===== delete_user =====
describe('deleteUserTool', () => {
  it('ユーザーを削除し監査ログを記録する', async () => {
    vi.mocked(deleteUser).mockResolvedValue(true as never);

    const result = await deleteUserTool.handler({ user_id: 'user-1' }, mockContext);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('削除');
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        action: 'user.delete',
        targetId: 'user-1',
      }),
    );
  });

  it('user_id未指定はエラー', async () => {
    const result = await deleteUserTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(deleteUser)).not.toHaveBeenCalled();
  });

  it('ユーザーが見つからない場合はエラー', async () => {
    vi.mocked(deleteUser).mockResolvedValue(false as never);

    const result = await deleteUserTool.handler({ user_id: 'nonexistent' }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(createAdminAuditLog)).not.toHaveBeenCalled();
  });
});

// ===== get_user_login_history =====
describe('getUserLoginHistoryTool', () => {
  it('ログイン履歴を返す', async () => {
    const ev = { id: 'ev-1', user_id: 'user-1', provider: 'google', created_at: '2024-01-01T00:00:00Z' };
    vi.mocked(getLoginEventsByUserId).mockResolvedValue({ events: [ev], total: 1 } as never);

    const result = await getUserLoginHistoryTool.handler({ user_id: 'user-1' }, mockContext);

    expect(result.isError).toBeUndefined();
    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(mockContext.db, 'user-1', 20);
  });

  it('limitを指定できる', async () => {
    vi.mocked(getLoginEventsByUserId).mockResolvedValue({ events: [], total: 0 } as never);

    await getUserLoginHistoryTool.handler({ user_id: 'user-1', limit: 5 }, mockContext);

    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(mockContext.db, 'user-1', 5);
  });

  it('limitは100を超えない', async () => {
    vi.mocked(getLoginEventsByUserId).mockResolvedValue({ events: [], total: 0 } as never);

    await getUserLoginHistoryTool.handler({ user_id: 'user-1', limit: 500 }, mockContext);

    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(mockContext.db, 'user-1', 100);
  });

  it('user_id未指定はエラー', async () => {
    const result = await getUserLoginHistoryTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
  });
});

// ===== get_user_providers =====
describe('getUserProvidersTool', () => {
  it('プロバイダー一覧を返す', async () => {
    const providers = [{ provider: 'google', subject: 'sub-1' }];
    vi.mocked(getUserProviders).mockResolvedValue(providers as never);

    const result = await getUserProvidersTool.handler({ user_id: 'user-1' }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
  });

  it('user_id未指定はエラー', async () => {
    const result = await getUserProvidersTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
  });
});
