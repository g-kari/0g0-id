import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { logAdminAudit, extractErrorMessage } from "./audit";
import { createAdminAuditLog, createLogger } from "@0g0-id/shared";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    createLogger: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    createAdminAuditLog: vi.fn(),
  };
});

const mockCreateAdminAuditLog = createAdminAuditLog as ReturnType<typeof vi.fn>;
const mockAuditLogger = (createLogger as ReturnType<typeof vi.fn>).mock.results[0]?.value ?? {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createMockContext(sub = "admin-user-id", ip = "1.2.3.4") {
  return {
    get: vi.fn().mockReturnValue({ sub }),
    req: {
      raw: new Request("https://example.com", {
        headers: { "cf-connecting-ip": ip },
      }),
    },
    env: { DB: {} as D1Database },
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("logAdminAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("正常系: createAdminAuditLog が正しい引数で呼ばれる", async () => {
    const c = createMockContext("admin-001", "10.0.0.1");
    await logAdminAudit(c, {
      action: "user.ban",
      targetType: "user",
      targetId: "target-user-1",
      details: { reason: "spam" },
      status: "success",
    });

    expect(mockCreateAdminAuditLog).toHaveBeenCalledWith(c.env.DB, {
      adminUserId: "admin-001",
      action: "user.ban",
      targetType: "user",
      targetId: "target-user-1",
      details: { reason: "spam" },
      ipAddress: "10.0.0.1",
      status: "success",
    });
  });

  it("adminUserId を c.get('user').sub から取得する", async () => {
    const c = createMockContext("specific-admin-sub");
    await logAdminAudit(c, {
      action: "service.create",
      targetType: "service",
      targetId: "svc-1",
    });

    expect(c.get).toHaveBeenCalledWith("user");
    expect(mockCreateAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ adminUserId: "specific-admin-sub" }),
    );
  });

  it("ipAddress を cf-connecting-ip ヘッダから取得する", async () => {
    const c = createMockContext("admin-001", "192.168.1.100");
    await logAdminAudit(c, {
      action: "user.unban",
      targetType: "user",
      targetId: "target-user-2",
    });

    expect(mockCreateAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ipAddress: "192.168.1.100" }),
    );
  });

  it("status 省略時は 'success' がデフォルト", async () => {
    const c = createMockContext();
    await logAdminAudit(c, {
      action: "service.update",
      targetType: "service",
      targetId: "svc-2",
    });

    expect(mockCreateAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "success" }),
    );
  });

  it("details が null の場合", async () => {
    const c = createMockContext();
    await logAdminAudit(c, {
      action: "user.delete",
      targetType: "user",
      targetId: "target-user-3",
      details: null,
    });

    expect(mockCreateAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: null }),
    );
  });

  it("createAdminAuditLog が throw した場合、例外を握り潰してログに記録する", async () => {
    mockCreateAdminAuditLog.mockRejectedValueOnce(new Error("DB write failed"));
    const c = createMockContext();

    // 例外が伝播しないことを確認
    await expect(
      logAdminAudit(c, {
        action: "user.session_revoked",
        targetType: "user",
        targetId: "target-user-4",
      }),
    ).resolves.toBeUndefined();

    // auditLogger.error が呼ばれたことを確認
    const logger =
      (createLogger as ReturnType<typeof vi.fn>).mock.results[0]?.value ?? mockAuditLogger;
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to create admin audit log",
      expect.objectContaining({
        action: "user.session_revoked",
        targetType: "user",
        targetId: "target-user-4",
      }),
    );
  });
});

describe("extractErrorMessage", () => {
  it("Error オブジェクト → message を返す", () => {
    const err = new Error("something went wrong");
    expect(extractErrorMessage(err)).toBe("something went wrong");
  });

  it("非Error → 'Unknown error' を返す", () => {
    expect(extractErrorMessage("string error")).toBe("Unknown error");
    expect(extractErrorMessage(42)).toBe("Unknown error");
    expect(extractErrorMessage(null)).toBe("Unknown error");
    expect(extractErrorMessage(undefined)).toBe("Unknown error");
  });
});
