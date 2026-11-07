import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    COOKIE_NAMES: {
      IDP_STATE: "__Host-oauth-state",
      IDP_PKCE: "__Host-oauth-pkce",
      ADMIN_SESSION: "__Host-admin-session",
      ADMIN_STATE: "__Host-admin-oauth-state",
      USER_SESSION: "__Host-user-session",
      USER_STATE: "__Host-user-oauth-state",
    },
    logger: () => async (_c: unknown, next: () => Promise<void>) => next(),
    securityHeaders: () => async (_c: unknown, next: () => Promise<void>) => next(),
    bodyLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
    verifyAccessToken: vi.fn(),
    countUsers: vi.fn(),
    countAdminUsers: vi.fn(),
    countServices: vi.fn(),
    countActiveRefreshTokens: vi.fn(),
    getServiceById: vi.fn(),
    getServiceByClientId: vi.fn(),
    listServices: vi.fn(),
    createService: vi.fn(),
    updateService: vi.fn(),
    deleteService: vi.fn(),
    listServiceRedirectUris: vi.fn(),
    addServiceRedirectUri: vi.fn(),
    deleteServiceRedirectUri: vi.fn(),
    getUserById: vi.fn(),
    getUserByEmail: vi.fn(),
    listUsers: vi.fn(),
    updateUser: vi.fn(),
    deleteUser: vi.fn(),
    createUser: vi.fn(),
    createAuthCode: vi.fn(),
    getAuthCode: vi.fn(),
    markAuthCodeUsed: vi.fn(),
    createRefreshToken: vi.fn(),
    getRefreshToken: vi.fn(),
    revokeRefreshToken: vi.fn(),
    revokeRefreshTokenFamily: vi.fn(),
    generateAccessToken: vi.fn(),
    generateRefreshTokenValue: vi.fn(),
    hashToken: vi.fn(),
    // well-known route で使用
    getJWTKeys: vi.fn(),
    getJWKS: vi.fn(),
    // scheduled handler で使用
    cleanupExpiredAuthCodes: vi.fn().mockResolvedValue(0),
    deleteExpiredDeviceCodes: vi.fn().mockResolvedValue(undefined),
    cleanupExpiredMcpSessions: vi.fn().mockResolvedValue(0),
    cleanupExpiredRevokedAccessTokens: vi.fn().mockResolvedValue(0),
    deleteExpiredRefreshTokens: vi.fn().mockResolvedValue(0),
    cleanupStaleDbscChallenges: vi.fn().mockResolvedValue(undefined),
    uuidParamMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
  };
});

import type { IdpEnv } from "@0g0-id/shared";
import {
  getJWTKeys,
  cleanupExpiredAuthCodes,
  deleteExpiredDeviceCodes,
  cleanupExpiredMcpSessions,
  cleanupExpiredRevokedAccessTokens,
  deleteExpiredRefreshTokens,
  cleanupStaleDbscChallenges,
} from "@0g0-id/shared";
import { app } from "./index";
import worker from "./index";
import { _resetValidationCache } from "./utils/env-validation";

const mockEnv = {
  DB: {} as D1Database,
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  JWT_PRIVATE_KEY: "mock-private-key",
  JWT_PUBLIC_KEY: "mock-public-key",
  IDP_ORIGIN: "https://id.0g0.xyz",
  USER_ORIGIN: "https://user.0g0.xyz",
  ADMIN_ORIGIN: "https://admin.0g0.xyz",
  COOKIE_SECRET: "mock-cookie-secret-for-testing-32chars!!",
  PAIRWISE_SALT: "test-pairwise-salt-value",
};

describe("GET /api/health", () => {
  it("200を返してstatus okとworker名を含む", async () => {
    const res = await app.request(
      "https://id.0g0.xyz/api/health",
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string; worker: string; timestamp: string }>();
    expect(body.status).toBe("ok");
    expect(body.worker).toBe("id");
    expect(typeof body.timestamp).toBe("string");
  });
});

describe("onError ハンドラ", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("未処理の例外で500とINTERNAL_ERRORを返す", async () => {
    // getJWTKeys をスローさせて /.well-known/jwks.json 経由で app.onError を通過させる
    vi.mocked(getJWTKeys).mockRejectedValue(new Error("unexpected db error"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request(
      "https://id.0g0.xyz/.well-known/jwks.json",
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    consoleSpy.mockRestore();

    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error");
  });
});

describe("notFound ハンドラ", () => {
  it("存在しないパスで404とNOT_FOUNDを返す", async () => {
    const res = await app.request(
      "https://id.0g0.xyz/this-route-does-not-exist",
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Not found");
  });
});

describe("環境変数バリデーション ミドルウェア", () => {
  beforeEach(() => {
    _resetValidationCache();
  });

  it("必須環境変数が欠けている場合に500とMISCONFIGURATIONを返す", async () => {
    const incompleteEnv = {
      DB: {} as D1Database,
      // GOOGLE_CLIENT_ID を意図的に省略
      GOOGLE_CLIENT_SECRET: "google-secret",
      JWT_PRIVATE_KEY: "mock-private-key",
      JWT_PUBLIC_KEY: "mock-public-key",
      IDP_ORIGIN: "https://id.0g0.xyz",
      USER_ORIGIN: "https://user.0g0.xyz",
      ADMIN_ORIGIN: "https://admin.0g0.xyz",
    };
    const res = await app.request(
      "https://id.0g0.xyz/api/health",
      undefined,
      incompleteEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("MISCONFIGURATION");
    expect(body.error.message).toBe("Server misconfiguration");
  });

  it("必須環境変数が空文字の場合に500とMISCONFIGURATIONを返す", async () => {
    const emptyKeyEnv = {
      ...mockEnv,
      JWT_PRIVATE_KEY: "",
    };
    const res = await app.request(
      "https://id.0g0.xyz/api/health",
      undefined,
      emptyKeyEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("MISCONFIGURATION");
  });

  it("全ての必須環境変数が揃っている場合は通常のレスポンスを返す", async () => {
    const res = await app.request(
      "https://id.0g0.xyz/api/health",
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
  });

  it("LINE_CLIENT_ID のみ設定（SECRET 未設定）の場合に500とMISCONFIGURATIONを返す", async () => {
    const envWithPartialLine = { ...mockEnv, LINE_CLIENT_ID: "line-client-id" };
    const res = await app.request(
      "https://id.0g0.xyz/api/health",
      undefined,
      envWithPartialLine as unknown as Record<string, string>,
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("MISCONFIGURATION");
  });

  it("LINE_CLIENT_SECRET のみ設定（ID 未設定）の場合に500とMISCONFIGURATIONを返す", async () => {
    const envWithPartialLine = { ...mockEnv, LINE_CLIENT_SECRET: "line-secret" };
    const res = await app.request(
      "https://id.0g0.xyz/api/health",
      undefined,
      envWithPartialLine as unknown as Record<string, string>,
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("MISCONFIGURATION");
  });

  it("GITHUB_CLIENT_ID のみ設定（SECRET 未設定）の場合に500とMISCONFIGURATIONを返す", async () => {
    const envWithPartialGithub = { ...mockEnv, GITHUB_CLIENT_ID: "github-client-id" };
    const res = await app.request(
      "https://id.0g0.xyz/api/health",
      undefined,
      envWithPartialGithub as unknown as Record<string, string>,
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("MISCONFIGURATION");
  });

  it("オプションプロバイダーの認証情報が両方揃っている場合は通常のレスポンスを返す", async () => {
    const envWithLine = {
      ...mockEnv,
      LINE_CLIENT_ID: "line-client-id",
      LINE_CLIENT_SECRET: "line-client-secret",
    };
    const res = await app.request(
      "https://id.0g0.xyz/api/health",
      undefined,
      envWithLine as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
  });
});

describe("scheduled handler", () => {
  beforeEach(() => {
    vi.mocked(cleanupExpiredAuthCodes).mockClear();
    vi.mocked(deleteExpiredDeviceCodes).mockClear();
    vi.mocked(cleanupExpiredMcpSessions).mockClear();
    vi.mocked(cleanupExpiredRevokedAccessTokens).mockClear();
    vi.mocked(deleteExpiredRefreshTokens).mockClear();
    vi.mocked(cleanupStaleDbscChallenges).mockClear();
  });

  it("全クリーンアップ処理を実行する", async () => {
    vi.mocked(cleanupExpiredAuthCodes).mockResolvedValue(5);
    vi.mocked(cleanupExpiredRevokedAccessTokens).mockResolvedValue(3);
    vi.mocked(deleteExpiredRefreshTokens).mockResolvedValue(2);

    const waitUntilFn = vi.fn();
    const ctx = { waitUntil: waitUntilFn } as unknown as ExecutionContext;
    const event = { cron: "0 0 * * *", scheduledTime: Date.now() } as unknown as ScheduledEvent;

    await worker.scheduled(event, mockEnv as unknown as IdpEnv, ctx);

    expect(waitUntilFn).toHaveBeenCalledOnce();
    // waitUntilに渡されたPromiseを実行
    await waitUntilFn.mock.calls[0][0];

    expect(cleanupExpiredAuthCodes).toHaveBeenCalledWith(mockEnv.DB);
    expect(deleteExpiredDeviceCodes).toHaveBeenCalledWith(mockEnv.DB);
    expect(cleanupExpiredMcpSessions).toHaveBeenCalledWith(mockEnv.DB);
    expect(cleanupExpiredRevokedAccessTokens).toHaveBeenCalledWith(mockEnv.DB);
    expect(deleteExpiredRefreshTokens).toHaveBeenCalledWith(mockEnv.DB);
    expect(cleanupStaleDbscChallenges).toHaveBeenCalledWith(mockEnv.DB);
  });
});

describe("scheduled handler の実 logger metadata 統合", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runCleanup(counts: [number, number, number]): Promise<void> {
    vi.mocked(cleanupExpiredAuthCodes).mockResolvedValue(counts[0]);
    vi.mocked(cleanupExpiredRevokedAccessTokens).mockResolvedValue(counts[1]);
    vi.mocked(deleteExpiredRefreshTokens).mockResolvedValue(counts[2]);
    const waitUntil = vi.fn();
    await worker.scheduled(
      {} as ScheduledEvent,
      mockEnv as unknown as IdpEnv,
      { waitUntil } as unknown as ExecutionContext,
    );
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0][0];
  }

  function entries(): unknown[] {
    return vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(line as string) as unknown);
  }

  const messages = [
    "認可コードクリーンアップ完了",
    "デバイスコードクリーンアップ完了",
    "MCPセッションクリーンアップ完了",
    "失効アクセストークンクリーンアップ完了",
    "期限切れリフレッシュトークンクリーンアップ完了",
    "DBSCチャレンジクリーンアップ完了",
  ];

  it("全3箇所のaggregate countと固定イベントを保つ", async () => {
    await runCleanup([0, 3, Number.MAX_SAFE_INTEGER]);
    expect(entries()).toEqual(
      messages.map((msg, index) => ({
        level: "info",
        ctx: "id",
        msg,
        ...(index === 0
          ? { data: { deletedCount: 0 } }
          : index === 3
            ? { data: { deletedCount: 3 } }
            : index === 4
              ? { data: { deletedCount: Number.MAX_SAFE_INTEGER } }
              : {}),
      })),
    );
  });

  it("不正なcountを変換・出力せずcleanup完了イベントを保つ", async () => {
    await runCleanup([-1, NaN, "synthetic-private-count" as unknown as number]);
    expect(entries()).toEqual(messages.map((msg) => ({ level: "info", ctx: "id", msg })));
  });
});

describe("onError の実 logger 統合 privacy 回帰", () => {
  const canary = "synthetic-only@example.invalid token=SYNTHETIC-ONLY-TOKEN";

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function requestFailure(error: Error): Promise<Response> {
    vi.mocked(getJWTKeys).mockRejectedValueOnce(error);
    return app.request(
      "https://id.0g0.xyz/.well-known/jwks.json",
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
  }

  async function expectFixedFailure(error: Error): Promise<void> {
    const response = await requestFailure(error);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ level: "error", ctx: "id", msg: "Unhandled error" }),
    );
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.debug).not.toHaveBeenCalled();
    const output = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(output).not.toContain(canary);
  }

  it("例外の message・stack・cause・任意extraをconsoleへ渡さない", async () => {
    const error = new Error(canary, { cause: new Error(canary) });
    error.stack = `${canary}\n    at synthetic-only.invalid`;
    Object.assign(error, { details: { email: canary }, self: error });
    await expectFixedFailure(error);
  });

  it.each(["message", "stack", "cause", "name", "toJSON", "details"])(
    "例外の %s getterを参照せず固定500を返す",
    async (field) => {
      const error = new Error("Synthetic failure");
      error.stack = "Synthetic stack";
      const getter = vi.fn(() => {
        throw new Error(canary);
      });
      Object.defineProperty(error, field, { get: getter, configurable: true });
      await expectFixedFailure(error);
      expect(getter).not.toHaveBeenCalled();
    },
  );
});
