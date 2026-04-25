import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

// --- モック定義 ---
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...original,
    parseJsonBody: vi.fn(),
    sha256: vi.fn(),
    findAndConsumeAuthCode: vi.fn(),
    findUserById: vi.fn(),
    generateCodeChallenge: vi.fn(),
    timingSafeEqual: vi.fn(),
    generatePairwiseSub: vi.fn(),
    signIdToken: vi.fn(),
    createBffSession: vi.fn(),
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

vi.mock("../../utils/service-auth", () => ({
  authenticateService: vi.fn(),
}));

vi.mock("../../utils/scopes", () => ({
  resolveEffectiveScope: vi.fn(),
}));

vi.mock("../../utils/token-pair", () => ({
  issueTokenPair: vi.fn(),
  ACCESS_TOKEN_TTL_SECONDS: 900,
}));

import {
  parseJsonBody,
  sha256,
  findAndConsumeAuthCode,
  findUserById,
  generateCodeChallenge,
  timingSafeEqual,
  generatePairwiseSub,
  signIdToken,
  createBffSession,
} from "@0g0-id/shared";
import { authenticateService } from "../../utils/service-auth";
import { resolveEffectiveScope } from "../../utils/scopes";
import { issueTokenPair } from "../../utils/token-pair";
import { handleExchange } from "./exchange";

// --- テスト用定数 ---
const mockEnv = createMockIdpEnv();

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
  code_hash: "hashed-code",
  user_id: "user-1",
  redirect_to: "https://user.0g0.xyz/callback",
  service_id: null,
  scope: null,
  nonce: null,
  provider: null,
  code_challenge: null,
  code_challenge_method: null,
  used_at: null,
  expires_at: "2099-01-01T00:00:00Z",
  created_at: "2024-01-01T00:00:00Z",
};

// --- ヘルパー ---
function buildApp() {
  const app = new Hono<{ Bindings: ReturnType<typeof createMockIdpEnv> }>();
  app.post("/auth/exchange", handleExchange);
  return app;
}

function makeRequest(body: string, headers?: Record<string, string>) {
  const app = buildApp();
  const reqHeaders: Record<string, string> = { "Content-Type": "application/json", ...headers };
  return app.request(
    new Request("https://id.0g0.xyz/auth/exchange", {
      method: "POST",
      headers: reqHeaders,
      body,
    }),
    undefined,
    mockEnv,
  );
}

// --- テスト ---
describe("POST /auth/exchange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sha256).mockResolvedValue("hashed-code");
    vi.mocked(generatePairwiseSub).mockResolvedValue("pairwise-sub-1");
    vi.mocked(signIdToken).mockResolvedValue("mock-id-token");
    vi.mocked(issueTokenPair).mockResolvedValue({
      accessToken: "mock-access-token",
      refreshToken: "mock-refresh-token",
    });
  });

  // =====================
  // バリデーション
  // =====================
  describe("バリデーション", () => {
    it("parseJsonBody 失敗 → parseJsonBody のレスポンスを返す", async () => {
      const errorResponse = new Response(JSON.stringify({ error: "bad" }), { status: 400 });
      vi.mocked(parseJsonBody).mockResolvedValue({ ok: false, response: errorResponse } as never);

      const res = await makeRequest("{}");
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // 認可コード検証
  // =====================
  describe("認可コード検証", () => {
    it("認可コードが無効 → 400 INVALID_CODE", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { code: "bad-code", redirect_to: "https://user.0g0.xyz/callback" },
      } as never);
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(null);

      const res = await makeRequest("{}");
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_CODE");
    });

    it("redirect_to 不一致 → 400 INVALID_CODE", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { code: "valid-code", redirect_to: "https://evil.example.com" },
      } as never);
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(mockAuthCode);

      const res = await makeRequest("{}");
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_CODE");
    });
  });

  // =====================
  // PKCE 検証
  // =====================
  describe("PKCE 検証", () => {
    it("code_challenge あり + code_verifier なし → 400", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { code: "valid-code", redirect_to: "https://user.0g0.xyz/callback" },
      } as never);
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
        ...mockAuthCode,
        code_challenge: "challenge-value",
      });

      const res = await makeRequest("{}");
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_CODE");
    });

    it("code_verifier 不一致 → 400", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: {
          code: "valid-code",
          redirect_to: "https://user.0g0.xyz/callback",
          code_verifier: "wrong-verifier",
        },
      } as never);
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
        ...mockAuthCode,
        code_challenge: "challenge-value",
      });
      vi.mocked(generateCodeChallenge).mockResolvedValue("different-challenge");
      vi.mocked(timingSafeEqual).mockReturnValue(false);

      const res = await makeRequest("{}");
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // ユーザー検証
  // =====================
  describe("ユーザー検証", () => {
    it("ユーザーが見つからない → 404 NOT_FOUND", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { code: "valid-code", redirect_to: "https://user.0g0.xyz/callback" },
      } as never);
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(mockAuthCode);
      vi.mocked(findUserById).mockResolvedValue(null);

      const res = await makeRequest("{}");
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("BANされたユーザー → 403 ACCOUNT_BANNED", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { code: "valid-code", redirect_to: "https://user.0g0.xyz/callback" },
      } as never);
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(mockAuthCode);
      vi.mocked(findUserById).mockResolvedValue({
        ...mockUser,
        banned_at: "2024-06-01T00:00:00Z",
      });

      const res = await makeRequest("{}");
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("ACCOUNT_BANNED");
    });
  });

  // =====================
  // BFF フロー（service_id なし）正常系
  // =====================
  describe("BFF フロー正常系", () => {
    it("正常にトークンを発行して 200 を返す", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { code: "valid-code", redirect_to: "https://user.0g0.xyz/callback" },
      } as never);
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(mockAuthCode);
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(createBffSession).mockResolvedValue(undefined);

      const res = await makeRequest("{}");
      expect(res.status).toBe(200);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.access_token).toBe("mock-access-token");
      expect(body.data.refresh_token).toBe("mock-refresh-token");
      expect(body.data.token_type).toBe("Bearer");
      expect(body.data.expires_in).toBe(900);
      expect(body.data.session_id).toBeDefined();
      expect((body.data.user as { role: string }).role).toBe("user");
    });

    it("BFF セッション作成失敗 → 500 INTERNAL_ERROR", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { code: "valid-code", redirect_to: "https://user.0g0.xyz/callback" },
      } as never);
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(mockAuthCode);
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(createBffSession).mockRejectedValue(new Error("DB error"));

      const res = await makeRequest("{}");
      expect(res.status).toBe(500);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });
  });

  // =====================
  // サービスOAuthフロー（service_id あり）
  // =====================
  describe("サービスOAuthフロー", () => {
    const serviceAuthCode = {
      ...mockAuthCode,
      service_id: "svc-1",
      scope: "openid profile",
    };

    const mockService = {
      id: "svc-1",
      name: "Test Service",
      client_id: "test-client",
      client_secret_hash: "hashed-secret",
      allowed_scopes: "openid profile email",
      owner_user_id: "user-1",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };

    it("サービス認証失敗 → 401 UNAUTHORIZED", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { code: "valid-code", redirect_to: "https://user.0g0.xyz/callback" },
      } as never);
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(serviceAuthCode);
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(authenticateService).mockResolvedValue(null);

      const res = await makeRequest("{}", { Authorization: "Basic dGVzdDp0ZXN0" });
      expect(res.status).toBe(401);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("service_id 不一致 → 401 UNAUTHORIZED", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { code: "valid-code", redirect_to: "https://user.0g0.xyz/callback" },
      } as never);
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(serviceAuthCode);
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(authenticateService).mockResolvedValue({ ...mockService, id: "svc-other" });

      const res = await makeRequest("{}", { Authorization: "Basic dGVzdDp0ZXN0" });
      expect(res.status).toBe(401);
    });

    it("スコープ解決失敗 → 400 INVALID_SCOPE", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { code: "valid-code", redirect_to: "https://user.0g0.xyz/callback" },
      } as never);
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(serviceAuthCode);
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(resolveEffectiveScope).mockReturnValue(undefined);

      const res = await makeRequest("{}", { Authorization: "Basic dGVzdDp0ZXN0" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_SCOPE");
    });

    it("正常にサービストークンを発行して 200 を返す", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { code: "valid-code", redirect_to: "https://user.0g0.xyz/callback" },
      } as never);
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(serviceAuthCode);
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(resolveEffectiveScope).mockReturnValue("openid profile");

      const res = await makeRequest("{}", { Authorization: "Basic dGVzdDp0ZXN0" });
      expect(res.status).toBe(200);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.access_token).toBe("mock-access-token");
      expect(body.data.id_token).toBe("mock-id-token");
      // サービスフローでは session_id は含まない
      expect(body.data.session_id).toBeUndefined();
      // サービスフローでは role は含まない
      expect((body.data.user as Record<string, unknown>).role).toBeUndefined();
    });

    it("authenticateService が例外を投げた → 500 INTERNAL_ERROR", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { code: "valid-code", redirect_to: "https://user.0g0.xyz/callback" },
      } as never);
      vi.mocked(findAndConsumeAuthCode).mockResolvedValue(serviceAuthCode);
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(authenticateService).mockRejectedValue(new Error("DB error"));

      const res = await makeRequest("{}", { Authorization: "Basic dGVzdDp0ZXN0" });
      expect(res.status).toBe(500);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });
  });
});
