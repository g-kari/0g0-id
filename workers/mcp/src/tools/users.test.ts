import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

vi.mock("@0g0-id/shared", () => ({
  listUsers: vi.fn(),
  countUsers: vi.fn(),
  findUserById: vi.fn(),
  banUserWithRevocation: vi.fn(),
  unbanUser: vi.fn(),
  deleteUser: vi.fn(),
  updateUserRoleWithRevocation: vi.fn(),
  getUserProviders: vi.fn(),
  getLoginEventsByUserId: vi.fn(),
  getUserLoginProviderStats: vi.fn(),
  getUserDailyLoginTrends: vi.fn(),
  listActiveSessionsByUserId: vi.fn(),
  listServicesByOwner: vi.fn(),
  listUserConnections: vi.fn(),
  revokeUserTokens: vi.fn(),
  deleteMcpSessionsByUser: vi.fn(),
  createAdminAuditLog: vi.fn(),
}));

import {
  listUsers,
  countUsers,
  findUserById,
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
} from "@0g0-id/shared";

import {
  listUsersTool,
  getUserTool,
  banUserTool,
  unbanUserTool,
  deleteUserTool,
  getUserLoginHistoryTool,
  getUserLoginStatsTool,
  getUserLoginTrendsTool,
  getUserProvidersTool,
  listUserSessionsTool,
  revokeUserSessionsTool,
  getUserOwnedServicesTool,
  getUserAuthorizedServicesTool,
  updateUserRoleTool,
} from "./users";
import type { McpContext } from "../mcp";

const mockContext: McpContext = {
  userId: "admin-1",
  userRole: "admin",
  db: {} as D1Database,
  idp: {} as Fetcher,
};

const mockUser = {
  id: "user-1",
  google_sub: "google-sub-1",
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: "test@example.com",
  email_verified: 1,
  name: "Test User",
  picture: null,
  phone: null,
  address: null,
  role: "user" as const,
  banned_at: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createAdminAuditLog).mockResolvedValue(undefined as never);
});

// ===== list_users =====
describe("listUsersTool", () => {
  it("デフォルトパラメータでユーザー一覧を返す", async () => {
    vi.mocked(listUsers).mockResolvedValue([mockUser] as never);
    vi.mocked(countUsers).mockResolvedValue(1);

    const result = await listUsersTool.handler({}, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pagination.page).toBe(1);
    expect(parsed.pagination.limit).toBe(50);
    expect(parsed.pagination.total).toBe(1);
    expect(parsed.users).toHaveLength(1);
    expect(parsed.users[0].id).toBe("user-1");
  });

  it("pageとlimitを指定できる", async () => {
    vi.mocked(listUsers).mockResolvedValue([]);
    vi.mocked(countUsers).mockResolvedValue(200);

    const result = await listUsersTool.handler({ page: 3, limit: 10 }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pagination.page).toBe(3);
    expect(parsed.pagination.limit).toBe(10);
    expect(parsed.pagination.totalPages).toBe(20);
  });

  it("limitは100を超えないよう丸める", async () => {
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

  it("roleフィルターを渡せる", async () => {
    vi.mocked(listUsers).mockResolvedValue([]);
    vi.mocked(countUsers).mockResolvedValue(0);

    await listUsersTool.handler({ role: "admin" }, mockContext);

    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(
      mockContext.db,
      50,
      0,
      expect.objectContaining({ role: "admin" }),
    );
  });

  it("無効なroleは無視する", async () => {
    vi.mocked(listUsers).mockResolvedValue([]);
    vi.mocked(countUsers).mockResolvedValue(0);

    await listUsersTool.handler({ role: "superuser" }, mockContext);

    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(
      mockContext.db,
      50,
      0,
      expect.objectContaining({ role: undefined }),
    );
  });
});

// ===== get_user =====
describe("getUserTool", () => {
  it("ユーザーを返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);

    const result = await getUserTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe("user-1");
  });

  it("user_id未指定はエラー", async () => {
    const result = await getUserTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
  });

  it("user_idが空文字はエラー", async () => {
    const result = await getUserTool.handler({ user_id: "" }, mockContext);
    expect(result.isError).toBe(true);
  });

  it("ユーザーが見つからない場合はエラー", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await getUserTool.handler({ user_id: "nonexistent" }, mockContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("見つかりません");
  });
});

// ===== ban_user =====
describe("banUserTool", () => {
  it("ユーザーをBANし監査ログを記録する", async () => {
    const bannedUser = { ...mockUser, banned_at: "2024-06-01T00:00:00Z" };
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(banUserWithRevocation).mockResolvedValue(bannedUser as never);

    const result = await banUserTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("BAN");
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        adminUserId: "admin-1",
        action: "user.ban",
        targetId: "user-1",
      }),
    );
  });

  it("user_id未指定はエラー", async () => {
    const result = await banUserTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
  });

  it("ユーザーが見つからない場合はエラー", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await banUserTool.handler({ user_id: "nonexistent" }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(banUserWithRevocation)).not.toHaveBeenCalled();
  });
});

// ===== unban_user =====
describe("unbanUserTool", () => {
  it("ユーザーのBANを解除し監査ログを記録する", async () => {
    vi.mocked(findUserById).mockResolvedValue({ ...mockUser, banned_at: "2024-06-01T00:00:00Z" });
    vi.mocked(unbanUser).mockResolvedValue(mockUser as never);

    const result = await unbanUserTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("BANを解除");
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        action: "user.unban",
        targetId: "user-1",
      }),
    );
  });

  it("user_id未指定はエラー", async () => {
    const result = await unbanUserTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("user_id は必須");
    expect(vi.mocked(findUserById)).not.toHaveBeenCalled();
  });

  it("ユーザーが見つからない場合はエラー", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await unbanUserTool.handler({ user_id: "nonexistent" }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(unbanUser)).not.toHaveBeenCalled();
  });
});

// ===== delete_user =====
describe("deleteUserTool", () => {
  it("ユーザーを削除し監査ログを記録する", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(deleteUser).mockResolvedValue(true as never);

    const result = await deleteUserTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("削除");
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        action: "user.delete",
        targetId: "user-1",
      }),
    );
  });

  it("user_id未指定はエラー", async () => {
    const result = await deleteUserTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(deleteUser)).not.toHaveBeenCalled();
  });

  it("ユーザーが見つからない場合はエラー", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await deleteUserTool.handler({ user_id: "nonexistent" }, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(deleteUser)).not.toHaveBeenCalled();
    expect(vi.mocked(createAdminAuditLog)).not.toHaveBeenCalled();
  });
});

// ===== get_user_login_history =====
describe("getUserLoginHistoryTool", () => {
  it("ログイン履歴を返す", async () => {
    const ev = {
      id: "ev-1",
      user_id: "user-1",
      provider: "google",
      created_at: "2024-01-01T00:00:00Z",
    };
    vi.mocked(getLoginEventsByUserId).mockResolvedValue({ events: [ev], total: 1 } as never);

    const result = await getUserLoginHistoryTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(mockContext.db, "user-1", 20);
  });

  it("limitを指定できる", async () => {
    vi.mocked(getLoginEventsByUserId).mockResolvedValue({ events: [], total: 0 } as never);

    await getUserLoginHistoryTool.handler({ user_id: "user-1", limit: 5 }, mockContext);

    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(mockContext.db, "user-1", 5);
  });

  it("limitは100を超えない", async () => {
    vi.mocked(getLoginEventsByUserId).mockResolvedValue({ events: [], total: 0 } as never);

    await getUserLoginHistoryTool.handler({ user_id: "user-1", limit: 500 }, mockContext);

    expect(vi.mocked(getLoginEventsByUserId)).toHaveBeenCalledWith(mockContext.db, "user-1", 100);
  });

  it("user_id未指定はエラー", async () => {
    const result = await getUserLoginHistoryTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
  });
});

// ===== get_user_login_stats =====
describe("getUserLoginStatsTool", () => {
  const mockStats = [
    { provider: "google", count: 10 },
    { provider: "github", count: 3 },
  ];

  it("プロバイダー別統計を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserLoginProviderStats).mockResolvedValue(mockStats as never);

    const result = await getUserLoginStatsTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.stats).toHaveLength(2);
    expect(parsed.days).toBe(30);
    expect(vi.mocked(getUserLoginProviderStats)).toHaveBeenCalledWith(
      mockContext.db,
      "user-1",
      expect.any(String),
    );
  });

  it("daysパラメータを指定できる", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserLoginProviderStats).mockResolvedValue([] as never);

    const result = await getUserLoginStatsTool.handler({ user_id: "user-1", days: 7 }, mockContext);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.days).toBe(7);
  });

  it("daysは365を超えない", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserLoginProviderStats).mockResolvedValue([] as never);

    const result = await getUserLoginStatsTool.handler(
      { user_id: "user-1", days: 999 },
      mockContext,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.days).toBe(365);
  });

  it("user_id未指定はエラー", async () => {
    const result = await getUserLoginStatsTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
  });

  it("ユーザーが見つからない場合はエラー", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await getUserLoginStatsTool.handler({ user_id: "nonexistent" }, mockContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("見つかりません");
    expect(vi.mocked(getUserLoginProviderStats)).not.toHaveBeenCalled();
  });
});

// ===== get_user_login_trends =====
describe("getUserLoginTrendsTool", () => {
  const mockTrends = [
    { date: "2024-01-01", count: 3 },
    { date: "2024-01-02", count: 5 },
  ];

  it("日別トレンドを返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserDailyLoginTrends).mockResolvedValue(mockTrends as never);

    const result = await getUserLoginTrendsTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.trends).toHaveLength(2);
    expect(parsed.days).toBe(30);
    expect(vi.mocked(getUserDailyLoginTrends)).toHaveBeenCalledWith(mockContext.db, "user-1", 30);
  });

  it("daysパラメータを指定できる", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserDailyLoginTrends).mockResolvedValue([] as never);

    const result = await getUserLoginTrendsTool.handler(
      { user_id: "user-1", days: 14 },
      mockContext,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.days).toBe(14);
    expect(vi.mocked(getUserDailyLoginTrends)).toHaveBeenCalledWith(mockContext.db, "user-1", 14);
  });

  it("daysは365を超えない", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(getUserDailyLoginTrends).mockResolvedValue([] as never);

    const result = await getUserLoginTrendsTool.handler(
      { user_id: "user-1", days: 1000 },
      mockContext,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.days).toBe(365);
  });

  it("user_id未指定はエラー", async () => {
    const result = await getUserLoginTrendsTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
  });

  it("ユーザーが見つからない場合はエラー", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await getUserLoginTrendsTool.handler({ user_id: "nonexistent" }, mockContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("見つかりません");
    expect(vi.mocked(getUserDailyLoginTrends)).not.toHaveBeenCalled();
  });
});

// ===== get_user_providers =====
describe("getUserProvidersTool", () => {
  it("プロバイダー一覧を返す", async () => {
    const providers = [{ provider: "google", subject: "sub-1" }];
    vi.mocked(getUserProviders).mockResolvedValue(providers as never);

    const result = await getUserProvidersTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
  });

  it("user_id未指定はエラー", async () => {
    const result = await getUserProvidersTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
  });
});

// ===== list_user_sessions =====
describe("listUserSessionsTool", () => {
  const mockSession = {
    id: "token-1",
    service_id: null,
    service_name: null,
    created_at: "2024-01-01T00:00:00Z",
    expires_at: "2024-01-31T00:00:00Z",
  };

  it("アクティブセッション一覧を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(listActiveSessionsByUserId).mockResolvedValue([mockSession] as never);

    const result = await listUserSessionsTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].id).toBe("token-1");
    expect(parsed.user.id).toBe("user-1");
  });

  it("セッションなしの場合は空配列を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(listActiveSessionsByUserId).mockResolvedValue([]);

    const result = await listUserSessionsTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(0);
    expect(parsed.sessions).toHaveLength(0);
  });

  it("user_id未指定はエラー", async () => {
    const result = await listUserSessionsTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(listActiveSessionsByUserId)).not.toHaveBeenCalled();
  });

  it("user_idが空文字はエラー", async () => {
    const result = await listUserSessionsTool.handler({ user_id: "" }, mockContext);
    expect(result.isError).toBe(true);
  });

  it("ユーザーが見つからない場合はエラー", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await listUserSessionsTool.handler({ user_id: "nonexistent" }, mockContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("見つかりません");
    expect(vi.mocked(listActiveSessionsByUserId)).not.toHaveBeenCalled();
  });
});

// ===== revoke_user_sessions =====
describe("revokeUserSessionsTool", () => {
  it("全セッションを失効させ監査ログを記録する", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(revokeUserTokens).mockResolvedValue(undefined as never);

    const result = await revokeUserSessionsTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("失効");
    expect(vi.mocked(revokeUserTokens)).toHaveBeenCalledWith(
      mockContext.db,
      "user-1",
      "admin_action",
    );
    expect(vi.mocked(deleteMcpSessionsByUser)).toHaveBeenCalledWith(mockContext.db, "user-1");
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        adminUserId: "admin-1",
        action: "user.sessions_revoked",
        targetType: "user",
        targetId: "user-1",
      }),
    );
  });

  it("user_id未指定はエラー", async () => {
    const result = await revokeUserSessionsTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(revokeUserTokens)).not.toHaveBeenCalled();
  });

  it("user_idが空文字はエラー", async () => {
    const result = await revokeUserSessionsTool.handler({ user_id: "" }, mockContext);
    expect(result.isError).toBe(true);
  });

  it("ユーザーが見つからない場合はエラー", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await revokeUserSessionsTool.handler({ user_id: "nonexistent" }, mockContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("見つかりません");
    expect(vi.mocked(revokeUserTokens)).not.toHaveBeenCalled();
    expect(vi.mocked(createAdminAuditLog)).not.toHaveBeenCalled();
  });
});

// ===== get_user_owned_services =====
describe("getUserOwnedServicesTool", () => {
  const mockService = {
    id: "svc-1",
    name: "My Service",
    client_id: "client-1",
    client_secret_hash: "hash",
    allowed_scopes: "openid profile",
    owner_user_id: "user-1",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };

  it("所有サービス一覧を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(listServicesByOwner).mockResolvedValue([mockService] as never);

    const result = await getUserOwnedServicesTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1);
    expect(parsed.owned_services).toHaveLength(1);
    expect(parsed.owned_services[0].id).toBe("svc-1");
    expect(parsed.owned_services[0].name).toBe("My Service");
    expect(parsed.user.id).toBe("user-1");
    expect(vi.mocked(listServicesByOwner)).toHaveBeenCalledWith(mockContext.db, "user-1");
  });

  it("サービス未所有の場合は空配列を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(listServicesByOwner).mockResolvedValue([]);

    const result = await getUserOwnedServicesTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(0);
    expect(parsed.owned_services).toHaveLength(0);
  });

  it("user_id未指定はエラー", async () => {
    const result = await getUserOwnedServicesTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(listServicesByOwner)).not.toHaveBeenCalled();
  });

  it("ユーザーが見つからない場合はエラー", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await getUserOwnedServicesTool.handler({ user_id: "nonexistent" }, mockContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("見つかりません");
    expect(vi.mocked(listServicesByOwner)).not.toHaveBeenCalled();
  });
});

// ===== get_user_authorized_services =====
describe("getUserAuthorizedServicesTool", () => {
  const mockConnection = {
    service_id: "svc-1",
    service_name: "My Service",
    client_id: "client-1",
    first_authorized_at: "2024-01-01T00:00:00Z",
    last_authorized_at: "2024-06-01T00:00:00Z",
  };

  it("認可済みサービス一覧を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(listUserConnections).mockResolvedValue([mockConnection] as never);

    const result = await getUserAuthorizedServicesTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1);
    expect(parsed.authorized_services).toHaveLength(1);
    expect(parsed.authorized_services[0].service_id).toBe("svc-1");
    expect(parsed.user.id).toBe("user-1");
    expect(vi.mocked(listUserConnections)).toHaveBeenCalledWith(mockContext.db, "user-1");
  });

  it("認可済みサービスなしの場合は空配列を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(listUserConnections).mockResolvedValue([]);

    const result = await getUserAuthorizedServicesTool.handler({ user_id: "user-1" }, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(0);
    expect(parsed.authorized_services).toHaveLength(0);
  });

  it("user_id未指定はエラー", async () => {
    const result = await getUserAuthorizedServicesTool.handler({}, mockContext);
    expect(result.isError).toBe(true);
    expect(vi.mocked(listUserConnections)).not.toHaveBeenCalled();
  });

  it("ユーザーが見つからない場合はエラー", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await getUserAuthorizedServicesTool.handler(
      { user_id: "nonexistent" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("見つかりません");
    expect(vi.mocked(listUserConnections)).not.toHaveBeenCalled();
  });
});

describe("updateUserRoleTool", () => {
  it("ユーザーのロールを user → admin に変更し監査ログを記録する", async () => {
    vi.mocked(findUserById).mockResolvedValue({ ...mockUser, role: "user" });
    vi.mocked(updateUserRoleWithRevocation).mockResolvedValue({
      ...mockUser,
      role: "admin",
    } as never);

    const result = await updateUserRoleTool.handler(
      { user_id: "user-1", role: "admin" },
      mockContext,
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.role).toBe("admin");
    expect(vi.mocked(updateUserRoleWithRevocation)).toHaveBeenCalledWith(
      mockContext.db,
      "user-1",
      "admin",
    );
    expect(vi.mocked(createAdminAuditLog)).toHaveBeenCalledWith(
      mockContext.db,
      expect.objectContaining({
        action: "user.role_change",
        targetId: "user-1",
        details: { from: "user", to: "admin" },
      }),
    );
  });

  it("既に同じロールの場合は変更せずメッセージを返す", async () => {
    vi.mocked(findUserById).mockResolvedValue({ ...mockUser, role: "admin" });

    const result = await updateUserRoleTool.handler(
      { user_id: "user-1", role: "admin" },
      mockContext,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("既に");
    expect(vi.mocked(updateUserRoleWithRevocation)).not.toHaveBeenCalled();
  });

  it("user_id未指定はエラー", async () => {
    const result = await updateUserRoleTool.handler({ role: "admin" }, mockContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("user_id は必須");
    expect(vi.mocked(findUserById)).not.toHaveBeenCalled();
  });

  it("不正なroleはエラー", async () => {
    const result = await updateUserRoleTool.handler(
      { user_id: "user-1", role: "superadmin" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("role");
    expect(vi.mocked(findUserById)).not.toHaveBeenCalled();
  });

  it("ユーザーが見つからない場合はエラー", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const result = await updateUserRoleTool.handler(
      { user_id: "nonexistent", role: "admin" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(vi.mocked(updateUserRoleWithRevocation)).not.toHaveBeenCalled();
  });
});
