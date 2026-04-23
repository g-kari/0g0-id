import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

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
    createLogger: vi.fn().mockReturnValue({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
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
