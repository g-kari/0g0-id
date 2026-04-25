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
    findAndConsumeAuthCode: vi.fn(),
    findUserById: vi.fn(),
    generateCodeChallenge: vi.fn(),
    timingSafeEqual: vi.fn(),
    normalizeRedirectUri: vi.fn(),
    matchRedirectUri: vi.fn(),
  };
});

vi.mock("../../utils/scopes", () => ({
  resolveEffectiveScope: vi.fn(),
}));

vi.mock("../../utils/token-pair", () => ({
  issueTokenPair: vi.fn(),
  buildTokenResponse: vi.fn(),
  issueIdToken: vi.fn(),
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
  findAndConsumeAuthCode,
  findUserById,
  generateCodeChallenge,
  timingSafeEqual,
  normalizeRedirectUri,
  matchRedirectUri,
} from "@0g0-id/shared";
import { resolveEffectiveScope } from "../../utils/scopes";
import { issueTokenPair, buildTokenResponse, issueIdToken } from "../../utils/token-pair";
import { resolveOAuthClient } from "./utils";
import { handleAuthorizationCodeGrant } from "./authorization-code-grant";

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

const mockAuthCode = {
  id: "ac-1",
  user_id: "user-1",
  service_id: "svc-1",
  code_hash: "hashed-code",
  redirect_to: "https://example.com/callback",
  scope: "openid profile email",
  code_challenge: null,
  code_challenge_method: null,
  nonce: null,
  provider: null,
  used_at: null,
  expires_at: "2099-01-01T00:00:00Z",
  created_at: "2024-01-01T00:00:00Z",
};

// --- ヘルパー ---
function createMockContext(
  params: Record<string, string>,
  authHeader?: string,
): TokenHandlerContext {
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
describe("handleAuthorizationCodeGrant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sha256).mockResolvedValue("hashed-code");
    vi.mocked(normalizeRedirectUri).mockReturnValue("https://example.com/callback");
    vi.mocked(matchRedirectUri).mockReturnValue(true);
  });

  // =====================
  // バリデーション
  // =====================
  describe("バリデーション", () => {
    it("code が未指定 → 400", async () => {
      const c = createMockContext({ redirect_uri: "https://example.com/callback" });
      const res = await handleAuthorizationCodeGrant(c, {
        redirect_uri: "https://example.com/callback",
      });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_request");
    });

    it("redirect_uri が未指定 → 400", async () => {
      const c = createMockContext({ code: "test-code" });
      const res = await handleAuthorizationCodeGrant(c, { code: "test-code" });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_request");
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

      const c = createMockContext({}, "Basic dGVzdDp0ZXN0");
      const res = await handleAuthorizationCodeGrant(c, {
        code: "test-code",
        redirect_uri: "https://example.com/callback",
      });

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="0g0-id"');
    });

    it("クライアント認証失敗（400）→ エラーレスポンス", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: false,
        error: "invalid_request",
        status: 400,
      });

      const c = createMockContext({});
      const res = await handleAuthorizationCodeGrant(c, {
        code: "test-code",
        redirect_uri: "https://example.com/callback",
      });

      expect(res.status).toBe(400);
    });
  });

  // =====================
  // 認可コード検証
  // =====================
  describe("認可コード検証", () => {
    it("認可コードが存在しない → 400 invalid_grant", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(null);

      const c = createMockContext({}, "Basic dGVzdDp0ZXN0");
      const res = await handleAuthorizationCodeGrant(c, {
        code: "test-code",
        redirect_uri: "https://example.com/callback",
      });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
    });

    it("service_id 不一致 → 400 invalid_grant", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
        ...mockAuthCode,
        service_id: "other-service",
      });

      const c = createMockContext({}, "Basic dGVzdDp0ZXN0");
      const res = await handleAuthorizationCodeGrant(c, {
        code: "test-code",
        redirect_uri: "https://example.com/callback",
      });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("not issued for this client");
    });

    it("redirect_uri 不一致 → 400 invalid_grant", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(mockAuthCode);
      vi.mocked(matchRedirectUri).mockReturnValue(false);

      const c = createMockContext({}, "Basic dGVzdDp0ZXN0");
      const res = await handleAuthorizationCodeGrant(c, {
        code: "test-code",
        redirect_uri: "https://evil.com/callback",
      });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("redirect_uri mismatch");
    });
  });

  // =====================
  // PKCE 検証
  // =====================
  describe("PKCE 検証", () => {
    it("パブリッククライアントで code_challenge なし → 400", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: true,
      });
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
        ...mockAuthCode,
        code_challenge: null,
      });

      const c = createMockContext({});
      const res = await handleAuthorizationCodeGrant(c, {
        code: "test-code",
        redirect_uri: "https://example.com/callback",
        client_id: "test-client",
      });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("PKCE is required");
    });

    it("code_challenge ありで code_verifier なし → 400", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
        ...mockAuthCode,
        code_challenge: "challenge-value",
      });

      const c = createMockContext({}, "Basic dGVzdDp0ZXN0");
      const res = await handleAuthorizationCodeGrant(c, {
        code: "test-code",
        redirect_uri: "https://example.com/callback",
      });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain("code_verifier is required");
    });

    it("code_verifier 不一致 → 400", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
        ...mockAuthCode,
        code_challenge: "challenge-value",
      });
      vi.mocked(generateCodeChallenge).mockResolvedValue("different-challenge");
      vi.mocked(timingSafeEqual).mockReturnValue(false);

      const c = createMockContext({}, "Basic dGVzdDp0ZXN0");
      const res = await handleAuthorizationCodeGrant(c, {
        code: "test-code",
        redirect_uri: "https://example.com/callback",
        code_verifier: "wrong-verifier-that-is-long-enough-to-pass-length-check",
      });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("code_verifier mismatch");
    });
  });

  // =====================
  // 正常系
  // =====================
  describe("正常系", () => {
    it("有効な認可コード → トークンレスポンス", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(mockAuthCode);
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(resolveEffectiveScope).mockReturnValue("openid profile email");
      vi.mocked(issueTokenPair).mockResolvedValue({
        accessToken: "access-token-1",
        refreshToken: "refresh-token-1",
      });
      vi.mocked(issueIdToken).mockResolvedValue("id-token-1");
      vi.mocked(buildTokenResponse).mockReturnValue({
        access_token: "access-token-1",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "refresh-token-1",
        scope: "openid profile email",
        id_token: "id-token-1",
      });

      const c = createMockContext({}, "Basic dGVzdDp0ZXN0");
      const res = await handleAuthorizationCodeGrant(c, {
        code: "test-code",
        redirect_uri: "https://example.com/callback",
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body.access_token).toBe("access-token-1");
      expect(body.refresh_token).toBe("refresh-token-1");
      expect(body.id_token).toBe("id-token-1");
      expect(body.scope).toBe("openid profile email");
    });
  });

  // =====================
  // エラー処理
  // =====================
  describe("エラー処理", () => {
    it("ユーザーが存在しない → 400", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(mockAuthCode);
      vi.mocked(findUserById).mockResolvedValue(null);

      const c = createMockContext({}, "Basic dGVzdDp0ZXN0");
      const res = await handleAuthorizationCodeGrant(c, {
        code: "test-code",
        redirect_uri: "https://example.com/callback",
      });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
    });

    it("ユーザーがBAN済み → 400", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(mockAuthCode);
      vi.mocked(findUserById).mockResolvedValue({
        ...mockUser,
        banned_at: "2024-06-01T00:00:00Z",
      });

      const c = createMockContext({}, "Basic dGVzdDp0ZXN0");
      const res = await handleAuthorizationCodeGrant(c, {
        code: "test-code",
        redirect_uri: "https://example.com/callback",
      });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_grant");
    });

    it("スコープ解決失敗 → 400 invalid_scope", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(mockAuthCode);
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(resolveEffectiveScope).mockReturnValue(undefined);

      const c = createMockContext({}, "Basic dGVzdDp0ZXN0");
      const res = await handleAuthorizationCodeGrant(c, {
        code: "test-code",
        redirect_uri: "https://example.com/callback",
      });

      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("invalid_scope");
    });

    it("issueTokenPair でエラー → 500 server_error", async () => {
      vi.mocked(resolveOAuthClient).mockResolvedValue({
        ok: true,
        service: mockService,
        isPublicClient: false,
      });
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(mockAuthCode);
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(resolveEffectiveScope).mockReturnValue("openid");
      vi.mocked(issueTokenPair).mockRejectedValue(new Error("DB error"));

      const c = createMockContext({}, "Basic dGVzdDp0ZXN0");
      const res = await handleAuthorizationCodeGrant(c, {
        code: "test-code",
        redirect_uri: "https://example.com/callback",
      });

      expect(res.status).toBe(500);
      const body = await res.json<Record<string, unknown>>();
      expect(body.error).toBe("server_error");
    });
  });
});
