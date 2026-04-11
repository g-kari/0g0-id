import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

vi.mock("@0g0-id/shared", () => ({
  listAdminAuditLogs: vi.fn(),
  getAuditLogStats: vi.fn(),
}));

import { listAdminAuditLogs, getAuditLogStats } from "@0g0-id/shared";

import { getAuditLogsTool, getAuditStatsTool } from "./audit";
import type { McpContext } from "../mcp";

const mockContext: McpContext = {
  userId: "admin-1",
  userRole: "admin",
  db: {} as D1Database,
  idp: {} as Fetcher,
};

const mockLog = {
  id: "log-1",
  admin_user_id: "admin-1",
  action: "user.ban",
  target_id: "user-2",
  status: "success",
  details: null,
  created_at: "2026-04-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listAdminAuditLogs).mockResolvedValue({ logs: [mockLog], total: 1 } as never);
  vi.mocked(getAuditLogStats).mockResolvedValue({
    action_stats: [],
    admin_stats: [],
    daily_stats: [],
  } as never);
});

// ===== get_audit_logs =====
describe("getAuditLogsTool", () => {
  it("logsとpaginationを含む結果を返す", async () => {
    const result = await getAuditLogsTool.handler({}, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.logs).toHaveLength(1);
    expect(parsed.logs[0].id).toBe("log-1");
    expect(parsed.pagination.page).toBe(1);
    expect(parsed.pagination.limit).toBe(50);
    expect(parsed.pagination.total).toBe(1);
    expect(parsed.pagination.totalPages).toBe(1);
  });

  it("デフォルトはpage=1, limit=50でDB呼び出しする", async () => {
    await getAuditLogsTool.handler({}, mockContext);

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(
      mockContext.db,
      50,
      0, // offset = (1-1)*50
      {},
    );
  });

  it("page/limitを指定できる", async () => {
    vi.mocked(listAdminAuditLogs).mockResolvedValue({ logs: [], total: 200 } as never);

    const result = await getAuditLogsTool.handler({ page: 3, limit: 20 }, mockContext);
    const parsed = JSON.parse(result.content[0].text);

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(
      mockContext.db,
      20,
      40, // offset = (3-1)*20
      {},
    );
    expect(parsed.pagination.page).toBe(3);
    expect(parsed.pagination.limit).toBe(20);
    expect(parsed.pagination.totalPages).toBe(10);
  });

  it("limitは最大100にクランプする", async () => {
    await getAuditLogsTool.handler({ limit: 200 }, mockContext);

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(mockContext.db, 100, 0, {});
  });

  it("limit=0はfalsy扱いでデフォルト50になる", async () => {
    // Number(0) || 50 = 50 (0はfalsy)
    await getAuditLogsTool.handler({ limit: 0 }, mockContext);

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(mockContext.db, 50, 0, {});
  });

  it("limitは負の値に対して最小1にクランプする", async () => {
    await getAuditLogsTool.handler({ limit: -10 }, mockContext);

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(mockContext.db, 1, 0, {});
  });

  it("pageは最小1にクランプする", async () => {
    await getAuditLogsTool.handler({ page: -5 }, mockContext);

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(
      mockContext.db,
      50,
      0, // offset = (1-1)*50
      {},
    );
  });

  it("actionフィルターを渡せる", async () => {
    await getAuditLogsTool.handler({ action: "user.ban" }, mockContext);

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(mockContext.db, 50, 0, {
      action: "user.ban",
    });
  });

  it("admin_user_idフィルターを渡せる", async () => {
    await getAuditLogsTool.handler({ admin_user_id: "admin-42" }, mockContext);

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(mockContext.db, 50, 0, {
      adminUserId: "admin-42",
    });
  });

  it("target_idフィルターを渡せる", async () => {
    await getAuditLogsTool.handler({ target_id: "user-99" }, mockContext);

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(mockContext.db, 50, 0, {
      targetId: "user-99",
    });
  });

  it("status=successフィルターを渡せる", async () => {
    await getAuditLogsTool.handler({ status: "success" }, mockContext);

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(mockContext.db, 50, 0, {
      status: "success",
    });
  });

  it("status=failureフィルターを渡せる", async () => {
    await getAuditLogsTool.handler({ status: "failure" }, mockContext);

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(mockContext.db, 50, 0, {
      status: "failure",
    });
  });

  it("無効なstatusはフィルターに含まれない", async () => {
    await getAuditLogsTool.handler({ status: "unknown" }, mockContext);

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(
      mockContext.db,
      50,
      0,
      {}, // 無効なstatusは除外
    );
  });

  it("空文字のactionはフィルターに含まれない", async () => {
    await getAuditLogsTool.handler({ action: "" }, mockContext);

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(mockContext.db, 50, 0, {});
  });

  it("複数フィルターを同時に指定できる", async () => {
    await getAuditLogsTool.handler(
      {
        action: "service.create",
        admin_user_id: "admin-1",
        target_id: "svc-5",
        status: "failure",
      },
      mockContext,
    );

    expect(vi.mocked(listAdminAuditLogs)).toHaveBeenCalledWith(mockContext.db, 50, 0, {
      action: "service.create",
      adminUserId: "admin-1",
      targetId: "svc-5",
      status: "failure",
    });
  });

  it("totalPages=0のとき（total=0）は0を返す", async () => {
    vi.mocked(listAdminAuditLogs).mockResolvedValue({ logs: [], total: 0 } as never);

    const result = await getAuditLogsTool.handler({}, mockContext);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.pagination.totalPages).toBe(0);
  });
});

// ===== get_audit_stats =====
describe("getAuditStatsTool", () => {
  it("action_stats/admin_stats/daily_statsを含む結果を返す", async () => {
    vi.mocked(getAuditLogStats).mockResolvedValue({
      action_stats: [{ action: "user.ban", count: 3 }],
      admin_stats: [{ admin_user_id: "admin-1", count: 5 }],
      daily_stats: [{ date: "2026-04-01", count: 2 }],
    } as never);

    const result = await getAuditStatsTool.handler({}, mockContext);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.action_stats).toHaveLength(1);
    expect(parsed.action_stats[0].action).toBe("user.ban");
    expect(parsed.admin_stats[0].admin_user_id).toBe("admin-1");
    expect(parsed.daily_stats[0].date).toBe("2026-04-01");
  });

  it("デフォルトは30日でDB呼び出しする", async () => {
    await getAuditStatsTool.handler({}, mockContext);

    expect(vi.mocked(getAuditLogStats)).toHaveBeenCalledWith(mockContext.db, 30);
  });

  it("daysパラメータを指定できる", async () => {
    await getAuditStatsTool.handler({ days: 7 }, mockContext);

    expect(vi.mocked(getAuditLogStats)).toHaveBeenCalledWith(mockContext.db, 7);
  });

  it("days=0はfalsy扱いでデフォルト30になる", async () => {
    await getAuditStatsTool.handler({ days: 0 }, mockContext);

    expect(vi.mocked(getAuditLogStats)).toHaveBeenCalledWith(mockContext.db, 30);
  });

  it("days=1は最小値として機能する", async () => {
    await getAuditStatsTool.handler({ days: 1 }, mockContext);

    expect(vi.mocked(getAuditLogStats)).toHaveBeenCalledWith(mockContext.db, 1);
  });

  it("daysは最大365にクランプする", async () => {
    await getAuditStatsTool.handler({ days: 500 }, mockContext);

    expect(vi.mocked(getAuditLogStats)).toHaveBeenCalledWith(mockContext.db, 365);
  });

  it("days=366は365にクランプする", async () => {
    await getAuditStatsTool.handler({ days: 366 }, mockContext);

    expect(vi.mocked(getAuditLogStats)).toHaveBeenCalledWith(mockContext.db, 365);
  });
});
