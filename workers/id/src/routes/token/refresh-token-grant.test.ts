import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

// --- モック定義 ---
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    sha256: vi.fn(),
    findRefreshTokenByHash: vi.fn(),
    findUserById: vi.fn(),
    findResourceServerByUri: vi.fn(),
  };
});

vi.mock("../../utils/scopes", () => ({
  resolveResourceScope: vi.fn(),
  isSubjectAllowedForResource: vi.fn(),
}));

vi.mock("../../utils/token-pair", () => ({
  buildTokenResponse: vi.fn(),
}));

vi.mock("../../utils/token-recovery", () => ({
  attemptUnrevokeToken: vi.fn(),
}));

vi.mock("../../utils/refresh-token-rotation", () => ({
  validateAndRevokeRefreshToken: vi.fn(),
  issueTokenPairWithRecovery: vi.fn(),
}));

vi.mock("./utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils")>();
  return {
    ...actual,
    resolveOAuthClient: vi.fn(),
  };
});

import {
  sha256,
  findRefreshTokenByHash,
  findUserById,
  findResourceServerByUri,
} from "@0g0-id/shared";
import { resolveResourceScope, isSubjectAllowedForResource } from "../../utils/scopes";
import { buildTokenResponse } from "../../utils/token-pair";
import { attemptUnrevokeToken } from "../../utils/token-recovery";
import {
  validateAndRevokeRefreshToken,
  issueTokenPairWithRecovery,
} from "../../utils/refresh-token-rotation";
import { resolveOAuthClient } from "./utils";
import { handleRefreshTokenGrant } from "./refresh-token-grant";

import type { TokenHandlerContext } from "./utils";

// --- テスト用定数 ---
const mockEnv = createMockIdpEnv();

const mockService = {
  id: "svc-1",
  name: "Test Service",
  client_id: "test-client",
  client_secret_hash: "hashed-secret",
  allowed_scopes: '["openid","profile","email"]',
  owner_user_id: "user-1",
  source: "admin",
  registration_access_token_hash: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const mockUser = {
  id: "user-1",
  google_sub: "g-1",
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: "user@example.com",
  email_verified: 1,
  name: "Test User",
  picture: "https://example.com/pic.jpg",
  phone: null,
  address: null,
  role: "user" as const,
  banned_at: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const mockStoredToken = {
  id: "rt-1",
  user_id: "user-1",
  service_id: "svc-1",
  token_hash: "hashed-token",
  family_id: "fam-1",
  revoked_at: null,
  revoked_reason: null,
  scope: "openid profile email",
  expires_at: "2099-01-01T00:00:00Z",
  created_at: "2024-01-01T00:00:00Z",
  resource: null,
  pairwise_sub: null,
};

// --- ヘルパー ---
function createMockContext(authHeader?: string): TokenHandlerContext {
  const headers: Record<string, string | undefined> = {};
  const responseHeaders: Record<string, string> = {};
  if (authHeader) headers["Authorization"] = authHeader;

  return {
    env: mockEnv,
    req: { header: (name: string) => headers[name] },
    header: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
    json: (data: unknown, status?: number) => {
      return Response.json(data, { status: status ?? 200, headers: responseHeaders });
    },
  };
}

// --- テスト ---
describe("handleRefreshTokenGrant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sha256).mockResolvedValue("hashed-token");
  });

  // =====================
  // バリデーション
  // =====================
  describe("バリデーション", () => {
    it("refresh_token が未指定 → 400", async () => {
      const c = createMockContext("Basic dGVzdDp0ZXN0");
      const res = await handleRefreshTokenGrant(c, {});

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain("refresh_token is required");
    });
  });

  // =====================
  // クライアント認証
  // =====================
  describe("クライアント認証", () => {
    it("クライアント認証失敗（invalid_client, 401）→ WWW-Authenticate 付き 401", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: false,
        error: "invalid_client",
        status: 401,
      });

      const c = createMockContext("Basic dGVzdDp0ZXN0");
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="0g0-id"');
    });
  });

  // =====================
  // トークンバリデーション
  // =====================
  describe("トークンバリデーション", () => {
    it("TOKEN_ROTATED → 400 invalid_grant (retry)", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: false,
        reason: "TOKEN_ROTATED",
      });

      const c = createMockContext("Basic dGVzdDp0ZXN0");
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("retry");
    });

    it("TOKEN_REUSE → 400 invalid_grant", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: false,
        reason: "TOKEN_REUSE",
      });

      const c = createMockContext("Basic dGVzdDp0ZXN0");
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("Token reuse detected");
    });

    it("INVALID_TOKEN → 400 invalid_grant", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: false,
        reason: "INVALID_TOKEN",
      });

      const c = createMockContext("Basic dGVzdDp0ZXN0");
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("Invalid refresh token");
    });
  });

  // =====================
  // サービス・有効期限チェック
  // =====================
  describe("サービス・有効期限チェック", () => {
    it("トークン期限切れ → 400", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: { ...mockStoredToken, expires_at: "2020-01-01T00:00:00Z" },
      });
      vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);

      const c = createMockContext("Basic dGVzdDp0ZXN0");
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("expired");
    });

    it("service_id 不一致 → attemptUnrevokeToken + 400", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: { ...mockStoredToken, service_id: "other-service" },
      });
      vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);

      const c = createMockContext("Basic dGVzdDp0ZXN0");
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("not issued for this client");
      expect(attemptUnrevokeToken).toHaveBeenCalled();
    });
  });

  // =====================
  // ユーザーチェック
  // =====================
  describe("ユーザーチェック", () => {
    it("ユーザーが存在しない → 400", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: mockStoredToken,
      });
      vi.mocked(findUserById).mockResolvedValue(null);

      const c = createMockContext("Basic dGVzdDp0ZXN0");
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("User not found");
    });

    it("ユーザーがBAN済み → 403 access_denied", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: mockStoredToken,
      });
      vi.mocked(findUserById).mockResolvedValue({
        ...mockUser,
        banned_at: "2024-06-01T00:00:00Z",
      });

      const c = createMockContext("Basic dGVzdDp0ZXN0");
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(403);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("access_denied");
    });
  });

  // =====================
  // 正常系
  // =====================
  describe("正常系", () => {
    it("有効なリフレッシュトークン → トークンレスポンス", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: mockStoredToken,
      });
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(issueTokenPairWithRecovery).mockResolvedValue({
        ok: true,
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
      });
      vi.mocked(buildTokenResponse).mockReturnValue({
        access_token: "new-access-token",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "new-refresh-token",
        scope: "openid profile email",
      });

      const c = createMockContext("Basic dGVzdDp0ZXN0");
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body.access_token).toBe("new-access-token");
      expect(body.refresh_token).toBe("new-refresh-token");
      expect(body.scope).toBe("openid profile email");
    });

    it.each([null, ""])("scope=%s falls back to openid without widening", async (scope) => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: { ...mockStoredToken, scope },
      });
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(issueTokenPairWithRecovery).mockResolvedValue({
        ok: true,
        accessToken: "at",
        refreshToken: "rt",
      });
      vi.mocked(buildTokenResponse).mockReturnValue({
        access_token: "at",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "rt",
        scope: "openid",
      });

      const c = createMockContext("Basic dGVzdDp0ZXN0");
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(200);
      expect(issueTokenPairWithRecovery).toHaveBeenCalledWith(
        mockEnv.DB,
        mockEnv,
        mockUser,
        expect.objectContaining({ scope: "openid" }),
        expect.any(String),
        expect.any(String),
        expect.anything(),
        "handleRefreshTokenGrant",
      );
    });
  });

  // =====================
  // RFC 8707 resource 束縛トークンの更新時再検証
  // =====================
  describe("RFC 8707 resource 束縛トークン", () => {
    const RESOURCE_URI = "https://dots-events.0g0.xyz/mcp";
    const mockResourceStoredToken = {
      ...mockStoredToken,
      scope: "events:read requests:update",
      resource: RESOURCE_URI,
    };
    const mockResourceServer = {
      id: "rs-1",
      uri: RESOURCE_URI,
      name: "dots-events",
      allowed_scopes: '["events:read","events:subscribe","requests:read","requests:update"]',
      allowed_subjects: "[]",
      owner_user_id: "user-1",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };

    function setupResourceRefresh() {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: true,
      });
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: mockResourceStoredToken,
      });
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(findResourceServerByUri).mockResolvedValue(mockResourceServer);
      vi.mocked(isSubjectAllowedForResource).mockReturnValue(true);
      vi.mocked(resolveResourceScope).mockReturnValue("events:read requests:update");
      vi.mocked(issueTokenPairWithRecovery).mockResolvedValue({
        ok: true,
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
      });
      vi.mocked(buildTokenResponse).mockImplementation(
        (accessToken: string, refreshToken: string, scope?: string) => ({
          access_token: accessToken,
          refresh_token: refreshToken,
          scope,
        }),
      );
    }

    it("正常系: resource と scope を引き継いで発行する", async () => {
      setupResourceRefresh();
      const c = createMockContext();
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(200);
      expect(issueTokenPairWithRecovery).toHaveBeenCalledWith(
        mockEnv.DB,
        mockEnv,
        mockUser,
        expect.objectContaining({ scope: "events:read requests:update", resource: RESOURCE_URI }),
        expect.any(String),
        expect.any(String),
        expect.anything(),
        "handleRefreshTokenGrant",
      );
    });

    it("scope は現在の allowed_scopes 上限で切り詰められる", async () => {
      setupResourceRefresh();
      // 管理者が allowed_scopes を狭めた想定
      vi.mocked(resolveResourceScope).mockReturnValue("events:read");
      const c = createMockContext();
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(200);
      expect(resolveResourceScope).toHaveBeenCalledWith(
        "events:read requests:update",
        mockResourceServer.allowed_scopes,
      );
      expect(issueTokenPairWithRecovery).toHaveBeenCalledWith(
        mockEnv.DB,
        mockEnv,
        mockUser,
        expect.objectContaining({ scope: "events:read" }),
        expect.any(String),
        expect.any(String),
        expect.anything(),
        "handleRefreshTokenGrant",
      );
      const body = await res.json<Record<string, unknown>>();
      expect(body.scope).toBe("events:read");
    });

    it("切り詰めの結果 scope が残らない → 400 invalid_scope", async () => {
      setupResourceRefresh();
      vi.mocked(resolveResourceScope).mockReturnValue(undefined);
      const c = createMockContext();
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_scope");
      expect(issueTokenPairWithRecovery).not.toHaveBeenCalled();
    });

    it("resource 登録が削除済み → 400 invalid_grant（新規発行しない）", async () => {
      setupResourceRefresh();
      vi.mocked(findResourceServerByUri).mockResolvedValue(null);
      const c = createMockContext();
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("no longer a registered resource server");
      expect(issueTokenPairWithRecovery).not.toHaveBeenCalled();
    });

    it("リクエストの resource が保存済みと異なる → 400 invalid_grant + トークンを戻す", async () => {
      setupResourceRefresh();
      const c = createMockContext();
      const res = await handleRefreshTokenGrant(c, {
        refresh_token: "test-rt",
        resource: "https://other.example/mcp",
      });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("does not match");
      expect(attemptUnrevokeToken).toHaveBeenCalled();
      expect(issueTokenPairWithRecovery).not.toHaveBeenCalled();
    });

    it("リクエストの resource が保存済みと一致 → 通常どおり発行する", async () => {
      setupResourceRefresh();
      const c = createMockContext();
      const res = await handleRefreshTokenGrant(c, {
        refresh_token: "test-rt",
        resource: RESOURCE_URI,
      });

      expect(res.status).toBe(200);
      expect(issueTokenPairWithRecovery).toHaveBeenCalled();
    });

    it("利用者制限で許可されていない subject → 400 invalid_grant", async () => {
      setupResourceRefresh();
      vi.mocked(findResourceServerByUri).mockResolvedValue({
        ...mockResourceServer,
        allowed_subjects: '["someone-else"]',
      });
      vi.mocked(isSubjectAllowedForResource).mockReturnValue(false);
      const c = createMockContext();
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("subject is not allowed");
      expect(issueTokenPairWithRecovery).not.toHaveBeenCalled();
    });
  });

  // =====================
  // トークン発行エラー
  // =====================
  describe("トークン発行エラー", () => {
    it("issueTokenPairWithRecovery → TOKEN_REUSE → 400", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: mockStoredToken,
      });
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(issueTokenPairWithRecovery).mockResolvedValue({
        ok: false,
        reason: "TOKEN_REUSE",
      });

      const c = createMockContext("Basic dGVzdDp0ZXN0");
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
    });

    it("issueTokenPairWithRecovery → INTERNAL_ERROR → 500", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: mockStoredToken,
      });
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(issueTokenPairWithRecovery).mockResolvedValue({
        ok: false,
        reason: "INTERNAL_ERROR",
      });

      const c = createMockContext("Basic dGVzdDp0ZXN0");
      const res = await handleRefreshTokenGrant(c, { refresh_token: "test-rt" });

      expect(res.status).toBe(500);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("server_error");
    });
  });
});
