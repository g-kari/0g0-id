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
    findUserById: vi.fn(),
    findServiceById: vi.fn(),
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

vi.mock("../../utils/scopes", () => ({
  resolveEffectiveScope: vi.fn(),
}));

vi.mock("../../utils/token-pair", () => ({
  ACCESS_TOKEN_TTL_SECONDS: 900,
}));

vi.mock("../../utils/refresh-token-rotation", () => ({
  validateAndRevokeRefreshToken: vi.fn(),
  issueTokenPairWithRecovery: vi.fn(),
}));

import { parseJsonBody, sha256, findUserById, findServiceById } from "@0g0-id/shared";
import {
  validateAndRevokeRefreshToken,
  issueTokenPairWithRecovery,
} from "../../utils/refresh-token-rotation";
import { handleRefresh } from "./refresh";

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

const mockStoredToken = {
  id: "rt-1",
  user_id: "user-1",
  service_id: null,
  token_hash: "hashed-token",
  family_id: "fam-1",
  revoked_at: null,
  revoked_reason: null,
  scope: null,
  expires_at: "2099-01-01T00:00:00Z",
  created_at: "2024-01-01T00:00:00Z",
  pairwise_sub: null,
};

// --- ヘルパー ---
function buildApp() {
  const app = new Hono<{ Bindings: ReturnType<typeof createMockIdpEnv> }>();
  app.post("/auth/refresh", handleRefresh);
  return app;
}

function makeRequest(body?: string) {
  const app = buildApp();
  return app.request(
    new Request("https://id.0g0.xyz/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ?? "{}",
    }),
    undefined,
    mockEnv,
  );
}

// --- テスト ---
describe("POST /auth/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sha256).mockResolvedValue("hashed-token");
  });

  // =====================
  // バリデーション
  // =====================
  describe("バリデーション", () => {
    it("parseJsonBody 失敗 → parseJsonBody のレスポンスを返す", async () => {
      const errorResponse = new Response(JSON.stringify({ error: "bad" }), { status: 400 });
      vi.mocked(parseJsonBody).mockResolvedValue({ ok: false, response: errorResponse } as never);

      const res = await makeRequest();
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // トークン検証
  // =====================
  describe("トークン検証", () => {
    it("TOKEN_ROTATED → 503", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "rotated-token" },
      } as never);
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: false,
        reason: "TOKEN_ROTATED",
      });

      const res = await makeRequest();
      expect(res.status).toBe(503);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("TOKEN_ROTATED");
    });

    it("TOKEN_REUSE → 401", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "reused-token" },
      } as never);
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: false,
        reason: "TOKEN_REUSE",
      });

      const res = await makeRequest();
      expect(res.status).toBe(401);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("TOKEN_REUSE");
    });

    it("INVALID_TOKEN → 401", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "invalid-token" },
      } as never);
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: false,
        reason: "INVALID_TOKEN",
      });

      const res = await makeRequest();
      expect(res.status).toBe(401);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_TOKEN");
    });

    it("トークン期限切れ → 401 TOKEN_EXPIRED", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "expired-token" },
      } as never);
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: { ...mockStoredToken, expires_at: "2020-01-01T00:00:00Z" },
      });

      const res = await makeRequest();
      expect(res.status).toBe(401);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("TOKEN_EXPIRED");
    });
  });

  // =====================
  // ユーザー検証
  // =====================
  describe("ユーザー検証", () => {
    it("ユーザーが見つからない → 401 INVALID_GRANT", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "valid-token" },
      } as never);
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: mockStoredToken,
      });
      vi.mocked(findUserById).mockResolvedValue(null);

      const res = await makeRequest();
      expect(res.status).toBe(401);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_GRANT");
    });

    it("BANされたユーザー → 403 ACCOUNT_BANNED", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "valid-token" },
      } as never);
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: mockStoredToken,
      });
      vi.mocked(findUserById).mockResolvedValue({
        ...mockUser,
        banned_at: "2024-06-01T00:00:00Z",
      });

      const res = await makeRequest();
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("ACCOUNT_BANNED");
    });
  });

  // =====================
  // サービストークンのリフレッシュ
  // =====================
  describe("サービストークンのリフレッシュ", () => {
    const serviceStoredToken = {
      ...mockStoredToken,
      service_id: "svc-1",
      scope: "openid profile",
    };

    it("サービスが削除済み → 401 INVALID_TOKEN", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "valid-token" },
      } as never);
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: serviceStoredToken,
      });
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(findServiceById).mockResolvedValue(null);

      const res = await makeRequest();
      expect(res.status).toBe(401);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_TOKEN");
    });
  });

  // =====================
  // 正常系
  // =====================
  describe("正常系", () => {
    it("BFF トークンリフレッシュ → 200 + 新トークン", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "valid-token" },
      } as never);
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

      const res = await makeRequest();
      expect(res.status).toBe(200);
      const body = await res.json<{ data: Record<string, unknown> }>();
      expect(body.data.access_token).toBe("new-access-token");
      expect(body.data.refresh_token).toBe("new-refresh-token");
      expect(body.data.token_type).toBe("Bearer");
      expect(body.data.expires_in).toBe(900);
      expect((body.data.user as { id: string }).id).toBe("user-1");
    });

    it("issueTokenPairWithRecovery TOKEN_REUSE → 401", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "valid-token" },
      } as never);
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: mockStoredToken,
      });
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(issueTokenPairWithRecovery).mockResolvedValue({
        ok: false,
        reason: "TOKEN_REUSE",
      });

      const res = await makeRequest();
      expect(res.status).toBe(401);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("TOKEN_REUSE");
    });

    it("issueTokenPairWithRecovery INTERNAL_ERROR → 500", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "valid-token" },
      } as never);
      vi.mocked(validateAndRevokeRefreshToken).mockResolvedValue({
        ok: true,
        storedToken: mockStoredToken,
      });
      vi.mocked(findUserById).mockResolvedValue(mockUser);
      vi.mocked(issueTokenPairWithRecovery).mockResolvedValue({
        ok: false,
        reason: "INTERNAL_ERROR",
      });

      const res = await makeRequest();
      expect(res.status).toBe(500);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });
  });
});
