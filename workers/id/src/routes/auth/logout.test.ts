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
    findRefreshTokenByHash: vi.fn(),
    revokeRefreshToken: vi.fn(),
    verifyAccessToken: vi.fn(),
    addRevokedAccessToken: vi.fn(),
    revokeBffSession: vi.fn(),
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

import {
  parseJsonBody,
  sha256,
  findRefreshTokenByHash,
  revokeRefreshToken,
  verifyAccessToken,
  addRevokedAccessToken,
  revokeBffSession,
} from "@0g0-id/shared";
import { handleLogout } from "./logout";

// --- テスト用定数 ---
const mockEnv = createMockIdpEnv();

const mockRefreshToken = {
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
  app.post("/auth/logout", handleLogout);
  return app;
}

function makeRequest(body: string, headers?: Record<string, string>) {
  const app = buildApp();
  const reqHeaders: Record<string, string> = { "Content-Type": "application/json", ...headers };
  return app.request(
    new Request("https://id.0g0.xyz/auth/logout", {
      method: "POST",
      headers: reqHeaders,
      body,
    }),
    undefined,
    mockEnv,
  );
}

// --- テスト ---
describe("POST /auth/logout", () => {
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

      const res = await makeRequest("{}");
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // アクセストークン失効
  // =====================
  describe("アクセストークン失効", () => {
    it("有効なアクセストークンを失効リストに追加する", async () => {
      const now = Math.floor(Date.now() / 1000);
      vi.mocked(parseJsonBody).mockResolvedValue({ ok: true, data: {} } as never);
      vi.mocked(verifyAccessToken).mockResolvedValue({
        jti: "jti-1",
        exp: now + 3600,
        iss: "https://id.0g0.xyz",
        sub: "user-1",
        aud: "https://id.0g0.xyz",
        iat: now,
        kid: "key-1",
        email: "user@example.com",
        role: "user",
      });
      vi.mocked(addRevokedAccessToken).mockResolvedValue(undefined);

      const res = await makeRequest("{}", { Authorization: "Bearer valid-jwt" });
      expect(res.status).toBe(200);
      expect(addRevokedAccessToken).toHaveBeenCalledWith(expect.anything(), "jti-1", now + 3600);
    });

    it("JWT検証失敗でもログアウトは成功する", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({ ok: true, data: {} } as never);
      vi.mocked(verifyAccessToken).mockRejectedValue(new Error("invalid"));

      const res = await makeRequest("{}", { Authorization: "Bearer invalid-jwt" });
      expect(res.status).toBe(200);
    });

    it("Authorization ヘッダーなしでもログアウトは成功する", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({ ok: true, data: {} } as never);

      const res = await makeRequest("{}");
      expect(res.status).toBe(200);
      expect(verifyAccessToken).not.toHaveBeenCalled();
    });
  });

  // =====================
  // BFF セッション失効
  // =====================
  describe("BFF セッション失効", () => {
    it("session_id ありで bff_session を失効させる", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { session_id: "550e8400-e29b-41d4-a716-446655440000" },
      } as never);
      vi.mocked(revokeBffSession).mockResolvedValue(undefined);

      const res = await makeRequest("{}");
      expect(res.status).toBe(200);
      expect(revokeBffSession).toHaveBeenCalledWith(
        expect.anything(),
        "550e8400-e29b-41d4-a716-446655440000",
        "user_logout",
      );
    });

    it("bff_session 失効失敗 → 500 INTERNAL_ERROR", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { session_id: "550e8400-e29b-41d4-a716-446655440000" },
      } as never);
      vi.mocked(revokeBffSession).mockRejectedValue(new Error("DB error"));

      const res = await makeRequest("{}");
      expect(res.status).toBe(500);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });
  });

  // =====================
  // リフレッシュトークン失効
  // =====================
  describe("リフレッシュトークン失効", () => {
    it("有効なリフレッシュトークンを失効させる", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "valid-rt" },
      } as never);
      vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken);
      vi.mocked(revokeRefreshToken).mockResolvedValue(undefined);

      const res = await makeRequest("{}");
      expect(res.status).toBe(200);
      expect(revokeRefreshToken).toHaveBeenCalledWith(expect.anything(), "rt-1", "user_logout");
    });

    it("既に失効済みのリフレッシュトークンは再失効しない", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "revoked-rt" },
      } as never);
      vi.mocked(findRefreshTokenByHash).mockResolvedValue({
        ...mockRefreshToken,
        revoked_at: "2024-06-01T00:00:00Z",
        revoked_reason: "rotation",
      });

      const res = await makeRequest("{}");
      expect(res.status).toBe(200);
      expect(revokeRefreshToken).not.toHaveBeenCalled();
    });

    it("リフレッシュトークンが見つからなくてもログアウトは成功する", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "unknown-rt" },
      } as never);
      vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);

      const res = await makeRequest("{}");
      expect(res.status).toBe(200);
      expect(revokeRefreshToken).not.toHaveBeenCalled();
    });

    it("findRefreshTokenByHash DB エラー → 500 INTERNAL_ERROR", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "valid-rt" },
      } as never);
      vi.mocked(findRefreshTokenByHash).mockRejectedValue(new Error("DB error"));

      const res = await makeRequest("{}");
      expect(res.status).toBe(500);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });

    it("revokeRefreshToken DB エラー → 500 INTERNAL_ERROR", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: { refresh_token: "valid-rt" },
      } as never);
      vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken);
      vi.mocked(revokeRefreshToken).mockRejectedValue(new Error("DB error"));

      const res = await makeRequest("{}");
      expect(res.status).toBe(500);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });
  });

  // =====================
  // 複合パターン
  // =====================
  describe("複合パターン", () => {
    it("refresh_token + session_id 両方を処理する", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({
        ok: true,
        data: {
          refresh_token: "valid-rt",
          session_id: "550e8400-e29b-41d4-a716-446655440000",
        },
      } as never);
      vi.mocked(revokeBffSession).mockResolvedValue(undefined);
      vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken);
      vi.mocked(revokeRefreshToken).mockResolvedValue(undefined);

      const res = await makeRequest("{}");
      expect(res.status).toBe(200);
      expect(revokeBffSession).toHaveBeenCalled();
      expect(revokeRefreshToken).toHaveBeenCalled();
      const body = await res.json<{ data: { success: boolean } }>();
      expect(body.data.success).toBe(true);
    });

    it("パラメータなしでも正常に 200 を返す", async () => {
      vi.mocked(parseJsonBody).mockResolvedValue({ ok: true, data: {} } as never);

      const res = await makeRequest("{}");
      expect(res.status).toBe(200);
      const body = await res.json<{ data: { success: boolean } }>();
      expect(body.data.success).toBe(true);
    });
  });
});
