import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

// --- モック定義 ---
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    findRefreshTokenByHash: vi.fn(),
    findUserById: vi.fn(),
    sha256: vi.fn(),
    generatePairwiseSub: vi.fn(),
    verifyAccessToken: vi.fn(),
    isAccessTokenRevoked: vi.fn(),
  };
});

vi.mock("../../utils/service-auth", () => ({
  authenticateService: vi.fn(),
}));

vi.mock("./utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils")>();
  return {
    ...actual,
    parseTokenBody: vi.fn(),
    applyUserClaims: vi.fn(),
  };
});

import {
  findRefreshTokenByHash,
  findUserById,
  sha256,
  generatePairwiseSub,
  verifyAccessToken,
  isAccessTokenRevoked,
} from "@0g0-id/shared";
import { authenticateService } from "../../utils/service-auth";
import { parseTokenBody, applyUserClaims } from "./utils";
import { handleIntrospect } from "./introspect";

// --- テスト用定数 ---
const baseUrl = "https://id.0g0.xyz";
const mockEnv = createMockIdpEnv();

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

const mockRefreshToken = {
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
  pairwise_sub: null,
};

const mockPayload = {
  iss: "https://id.0g0.xyz",
  sub: "user-1",
  aud: "https://id.0g0.xyz",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  jti: "jti-1",
  kid: "key-1",
  cid: "test-client",
  scope: "openid profile email",
  email: "user@example.com",
  role: "user" as const,
};

// --- ヘルパー ---
function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.post("/api/token/introspect", handleIntrospect);
  return app;
}

async function sendIntrospect(app: ReturnType<typeof buildApp>, authHeader?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader) headers["Authorization"] = authHeader;
  return app.request(
    new Request(`${baseUrl}/api/token/introspect`, { method: "POST", headers, body: "{}" }),
    undefined,
    mockEnv,
  );
}

// --- テスト ---
describe("POST /api/token/introspect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sha256).mockResolvedValue("hashed-token");
    vi.mocked(generatePairwiseSub).mockResolvedValue("pairwise-sub-1");
  });

  // =====================
  // 認証・バリデーション
  // =====================
  describe("認証・バリデーション", () => {
    it("サービス認証失敗（null）→ 401 + {active:false} + WWW-Authenticate", async () => {
      vi.mocked(authenticateService).mockResolvedValue(null);

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="0g0-id"');
      expect(await res.json<Record<string, unknown>>()).toEqual({ active: false });
    });

    it("サービス認証エラー（throws）→ 500 + server_error", async () => {
      vi.mocked(authenticateService).mockRejectedValue(new Error("DB connection failed"));

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(500);
      expect(await res.json<Record<string, unknown>>()).toEqual({ error: "server_error" });
    });

    it("ボディなし（parseTokenBody → null）→ 400 + {active:false}", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue(null);

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(400);
      expect(await res.json<Record<string, unknown>>()).toEqual({ active: false });
    });

    it("tokenフィールドなし → 400 + {active:false}", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({});

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(400);
      expect(await res.json<Record<string, unknown>>()).toEqual({ active: false });
    });
  });

  // =====================
  // JWT イントロスペクション
  // =====================
  describe("JWT イントロスペクション", () => {
    it("有効なJWT → {active:true} + claims", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({
        token: "valid-jwt",
        token_type_hint: "access_token",
      });
      vi.mocked(verifyAccessToken).mockResolvedValue(mockPayload);
      vi.mocked(isAccessTokenRevoked).mockResolvedValue(false);
      vi.mocked(findUserById).mockResolvedValue(mockUser);

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body.active).toBe(true);
      expect(body.iss).toBe("https://id.0g0.xyz");
      expect(body.sub).toBe("pairwise-sub-1");
      expect(body.token_type).toBe("access_token");
      expect(body.scope).toBe("openid profile email");
      expect(applyUserClaims).toHaveBeenCalled();
    });

    it("JWT が revoked → {active:false}", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({
        token: "revoked-jwt",
        token_type_hint: "access_token",
      });
      vi.mocked(verifyAccessToken).mockResolvedValue(mockPayload);
      vi.mocked(isAccessTokenRevoked).mockResolvedValue(true);

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      expect(await res.json<Record<string, unknown>>()).toEqual({ active: false });
    });

    it("JWT の cid 不一致 → {active:false}", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({
        token: "wrong-cid-jwt",
        token_type_hint: "access_token",
      });
      vi.mocked(verifyAccessToken).mockResolvedValue({
        ...mockPayload,
        cid: "other-client",
      });
      vi.mocked(isAccessTokenRevoked).mockResolvedValue(false);

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      expect(await res.json<Record<string, unknown>>()).toEqual({ active: false });
    });

    it("ユーザーがBAN → {active:false}", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({
        token: "banned-user-jwt",
        token_type_hint: "access_token",
      });
      vi.mocked(verifyAccessToken).mockResolvedValue(mockPayload);
      vi.mocked(isAccessTokenRevoked).mockResolvedValue(false);
      vi.mocked(findUserById).mockResolvedValue({
        ...mockUser,
        banned_at: "2024-06-01T00:00:00Z",
      });

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      expect(await res.json<Record<string, unknown>>()).toEqual({ active: false });
    });

    it("JWT検証失敗 → null（リフレッシュトークンへフォールスルー）", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({
        token: "invalid-jwt",
        token_type_hint: "access_token",
      });
      vi.mocked(verifyAccessToken).mockRejectedValue(new Error("invalid signature"));
      // フォールバック先のリフレッシュトークンも見つからない
      vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      expect(await res.json<Record<string, unknown>>()).toEqual({ active: false });
      // フォールバックでリフレッシュトークン検索が呼ばれたことを確認
      expect(findRefreshTokenByHash).toHaveBeenCalled();
    });
  });

  // =====================
  // リフレッシュトークン イントロスペクション
  // =====================
  describe("リフレッシュトークン イントロスペクション", () => {
    it("有効なリフレッシュトークン → {active:true} + claims + pairwise sub", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({ token: "valid-rt" });
      vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken);
      vi.mocked(findUserById).mockResolvedValue(mockUser);

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body.active).toBe(true);
      expect(body.iss).toBe("https://id.0g0.xyz");
      expect(body.sub).toBe("pairwise-sub-1");
      expect(body.token_type).toBe("refresh_token");
      expect(body.scope).toBe("openid profile email");
      expect(generatePairwiseSub).toHaveBeenCalledWith("test-client", "user-1", undefined);
      expect(applyUserClaims).toHaveBeenCalled();
    });

    it("トークンが存在しない → null（JWTへフォールスルー）", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({ token: "unknown-token" });
      vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
      // フォールバック先のJWTも検証失敗
      vi.mocked(verifyAccessToken).mockRejectedValue(new Error("invalid"));

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      expect(await res.json<Record<string, unknown>>()).toEqual({ active: false });
      // フォールバックでJWT検証が呼ばれたことを確認
      expect(verifyAccessToken).toHaveBeenCalled();
    });

    it("トークンが revoked → {active:false}", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({ token: "revoked-rt" });
      vi.mocked(findRefreshTokenByHash).mockResolvedValue({
        ...mockRefreshToken,
        revoked_at: "2024-06-01T00:00:00Z",
        revoked_reason: "rotation",
      });

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      expect(await res.json<Record<string, unknown>>()).toEqual({ active: false });
    });

    it("サービスID不一致 → {active:false}", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({ token: "other-service-rt" });
      vi.mocked(findRefreshTokenByHash).mockResolvedValue({
        ...mockRefreshToken,
        service_id: "other-service",
      });

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      expect(await res.json<Record<string, unknown>>()).toEqual({ active: false });
    });

    it("トークンが期限切れ → {active:false}", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({ token: "expired-rt" });
      vi.mocked(findRefreshTokenByHash).mockResolvedValue({
        ...mockRefreshToken,
        expires_at: "2020-01-01T00:00:00Z",
      });

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      expect(await res.json<Record<string, unknown>>()).toEqual({ active: false });
    });

    it("ユーザーがBAN → {active:false}", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({ token: "banned-user-rt" });
      vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken);
      vi.mocked(findUserById).mockResolvedValue({
        ...mockUser,
        banned_at: "2024-06-01T00:00:00Z",
      });

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      expect(await res.json<Record<string, unknown>>()).toEqual({ active: false });
    });
  });

  // =====================
  // token_type_hint の検索順最適化
  // =====================
  describe("token_type_hint の検索順最適化", () => {
    it('hint="access_token" → JWT を先に検索', async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({
        token: "some-token",
        token_type_hint: "access_token",
      });
      // JWT検証成功 → リフレッシュトークン検索は不要
      vi.mocked(verifyAccessToken).mockResolvedValue(mockPayload);
      vi.mocked(isAccessTokenRevoked).mockResolvedValue(false);
      vi.mocked(findUserById).mockResolvedValue(mockUser);

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body.active).toBe(true);
      expect(body.token_type).toBe("access_token");
      // JWT が先に呼ばれ、リフレッシュトークン検索は呼ばれない
      expect(verifyAccessToken).toHaveBeenCalled();
      expect(findRefreshTokenByHash).not.toHaveBeenCalled();
    });

    it("hint なし → リフレッシュトークンを先に検索", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({ token: "some-token" });
      // リフレッシュトークン検索成功 → JWT検証は不要
      vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken);
      vi.mocked(findUserById).mockResolvedValue(mockUser);

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body.active).toBe(true);
      expect(body.token_type).toBe("refresh_token");
      // リフレッシュトークンが先に呼ばれ、JWT検証は呼ばれない
      expect(findRefreshTokenByHash).toHaveBeenCalled();
      expect(verifyAccessToken).not.toHaveBeenCalled();
    });
  });

  // =====================
  // エラー処理
  // =====================
  describe("エラー処理", () => {
    it("DB エラー → 500 + server_error", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({ token: "some-token" });
      // リフレッシュトークン検索でDBエラー
      vi.mocked(findRefreshTokenByHash).mockRejectedValue(new Error("D1_ERROR"));

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(500);
      expect(await res.json<Record<string, unknown>>()).toEqual({ error: "server_error" });
    });

    it("両方 null → {active:false}", async () => {
      vi.mocked(authenticateService).mockResolvedValue(mockService);
      vi.mocked(parseTokenBody).mockResolvedValue({ token: "unknown-token" });
      // デフォルト順: リフレッシュトークン → JWT、両方 null
      vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
      vi.mocked(verifyAccessToken).mockRejectedValue(new Error("invalid"));

      const app = buildApp();
      const res = await sendIntrospect(app, "Basic dGVzdDp0ZXN0");

      expect(res.status).toBe(200);
      expect(await res.json<Record<string, unknown>>()).toEqual({ active: false });
    });
  });
});
