import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

// @0g0-id/sharedの全関数をモック
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    sha256: vi.fn(),
    findRefreshTokenByHash: vi.fn(),
    revokeRefreshToken: vi.fn(),
    verifyAccessToken: vi.fn(),
    addRevokedAccessToken: vi.fn(),
  };
});

vi.mock("../../utils/service-auth", () => ({
  authenticateService: vi.fn(),
}));

vi.mock("./utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils")>();
  return { ...actual, parseTokenBody: vi.fn() };
});

import {
  sha256,
  findRefreshTokenByHash,
  revokeRefreshToken,
  verifyAccessToken,
  addRevokedAccessToken,
} from "@0g0-id/shared";
import { authenticateService } from "../../utils/service-auth";
import { parseTokenBody } from "./utils";
import { handleRevoke } from "./revoke";

const baseUrl = "https://id.0g0.xyz";
const mockEnv = createMockIdpEnv();

const mockService = {
  id: "svc-1",
  name: "Test Service",
  client_id: "test-client",
  client_secret_hash: "hashed-secret",
  allowed_scopes: "openid profile",
  owner_user_id: "user-1",
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
  scope: "openid profile",
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
  email: "user@example.com",
  role: "user" as const,
};

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.post("/api/token/revoke", handleRevoke);
  return app;
}

function makeBasicAuth(clientId: string, secret: string): string {
  return `Basic ${btoa(`${clientId}:${secret}`)}`;
}

async function sendRevoke(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown> | null,
  authHeader?: string,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader) headers["Authorization"] = authHeader;
  return app.request(
    new Request(`${baseUrl}/api/token/revoke`, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
    undefined,
    mockEnv,
  );
}

describe("POST /api/token/revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- 認証エラー ---

  it("サービス認証失敗（authenticateService → null）→ 401 + invalid_client + WWW-Authenticate", async () => {
    vi.mocked(authenticateService).mockResolvedValue(null);

    const app = buildApp();
    const res = await sendRevoke(app, { token: "some-token" }, makeBasicAuth("bad", "creds"));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: "invalid_client" });
    expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="0g0-id"');
  });

  it("サービス認証エラー（authenticateService throws）→ 500 + server_error", async () => {
    vi.mocked(authenticateService).mockRejectedValue(new Error("DB error"));

    const app = buildApp();
    const res = await sendRevoke(app, { token: "some-token" }, makeBasicAuth("c", "s"));

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: "server_error" });
  });

  // --- リクエストボディエラー ---

  it("リクエストボディなし（parseTokenBody → null）→ 400 + invalid_request", async () => {
    vi.mocked(authenticateService).mockResolvedValue(mockService);
    vi.mocked(parseTokenBody).mockResolvedValue(null);

    const app = buildApp();
    const res = await sendRevoke(app, null, makeBasicAuth("test-client", "secret"));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "invalid_request" });
  });

  it("tokenフィールドなし → 400 + invalid_request", async () => {
    vi.mocked(authenticateService).mockResolvedValue(mockService);
    vi.mocked(parseTokenBody).mockResolvedValue({ token: "" });

    const app = buildApp();
    const res = await sendRevoke(app, { no_token: "x" }, makeBasicAuth("test-client", "secret"));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "invalid_request" });
  });

  // --- JWTアクセストークン失効 ---

  it("JWTアクセストークンの失効成功 → 200 + addRevokedAccessToken が呼ばれる", async () => {
    const jwtToken = "header.payload.signature";
    vi.mocked(authenticateService).mockResolvedValue(mockService);
    vi.mocked(parseTokenBody).mockResolvedValue({ token: jwtToken });
    vi.mocked(verifyAccessToken).mockResolvedValue(mockPayload);
    vi.mocked(addRevokedAccessToken).mockResolvedValue(undefined);

    const app = buildApp();
    const res = await sendRevoke(app, { token: jwtToken }, makeBasicAuth("test-client", "secret"));

    expect(res.status).toBe(200);
    expect(addRevokedAccessToken).toHaveBeenCalledWith(
      mockEnv.DB,
      mockPayload.jti,
      mockPayload.exp,
    );
    expect(sha256).not.toHaveBeenCalled();
  });

  it("JWT検証成功だが cid 不一致 → 200（addRevokedAccessToken は呼ばれない）", async () => {
    const jwtToken = "header.payload.signature";
    const wrongCidPayload = { ...mockPayload, cid: "other-client" };
    vi.mocked(authenticateService).mockResolvedValue(mockService);
    vi.mocked(parseTokenBody).mockResolvedValue({ token: jwtToken });
    vi.mocked(verifyAccessToken).mockResolvedValue(wrongCidPayload);

    const app = buildApp();
    const res = await sendRevoke(app, { token: jwtToken }, makeBasicAuth("test-client", "secret"));

    expect(res.status).toBe(200);
    expect(addRevokedAccessToken).not.toHaveBeenCalled();
  });

  it("JWT検証成功だが期限切れ → 200（addRevokedAccessToken は呼ばれない）", async () => {
    const jwtToken = "header.payload.signature";
    const expiredPayload = { ...mockPayload, exp: Math.floor(Date.now() / 1000) - 100 };
    vi.mocked(authenticateService).mockResolvedValue(mockService);
    vi.mocked(parseTokenBody).mockResolvedValue({ token: jwtToken });
    vi.mocked(verifyAccessToken).mockResolvedValue(expiredPayload);

    const app = buildApp();
    const res = await sendRevoke(app, { token: jwtToken }, makeBasicAuth("test-client", "secret"));

    expect(res.status).toBe(200);
    expect(addRevokedAccessToken).not.toHaveBeenCalled();
  });

  it("JWT検証失敗 → リフレッシュトークン処理にフォールスルー", async () => {
    const jwtToken = "header.payload.signature";
    vi.mocked(authenticateService).mockResolvedValue(mockService);
    vi.mocked(parseTokenBody).mockResolvedValue({ token: jwtToken });
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error("invalid JWT"));
    vi.mocked(sha256).mockResolvedValue("hashed-token");
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken);
    vi.mocked(revokeRefreshToken).mockResolvedValue(undefined);

    const app = buildApp();
    const res = await sendRevoke(app, { token: jwtToken }, makeBasicAuth("test-client", "secret"));

    expect(res.status).toBe(200);
    expect(sha256).toHaveBeenCalledWith(jwtToken);
    expect(findRefreshTokenByHash).toHaveBeenCalledWith(mockEnv.DB, "hashed-token");
    expect(revokeRefreshToken).toHaveBeenCalledWith(mockEnv.DB, "rt-1", "service_revoke");
  });

  // --- リフレッシュトークン失効 ---

  it("リフレッシュトークンの失効成功 → 200 + revokeRefreshToken が呼ばれる", async () => {
    const opaqueToken = "opaque-refresh-token";
    vi.mocked(authenticateService).mockResolvedValue(mockService);
    vi.mocked(parseTokenBody).mockResolvedValue({ token: opaqueToken });
    vi.mocked(sha256).mockResolvedValue("hashed-token");
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken);
    vi.mocked(revokeRefreshToken).mockResolvedValue(undefined);

    const app = buildApp();
    const res = await sendRevoke(
      app,
      { token: opaqueToken },
      makeBasicAuth("test-client", "secret"),
    );

    expect(res.status).toBe(200);
    expect(revokeRefreshToken).toHaveBeenCalledWith(mockEnv.DB, "rt-1", "service_revoke");
  });

  it("リフレッシュトークンが存在しない → 200（RFC 7009 情報漏洩防止）", async () => {
    const opaqueToken = "unknown-token";
    vi.mocked(authenticateService).mockResolvedValue(mockService);
    vi.mocked(parseTokenBody).mockResolvedValue({ token: opaqueToken });
    vi.mocked(sha256).mockResolvedValue("hashed-unknown");
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);

    const app = buildApp();
    const res = await sendRevoke(
      app,
      { token: opaqueToken },
      makeBasicAuth("test-client", "secret"),
    );

    expect(res.status).toBe(200);
    expect(revokeRefreshToken).not.toHaveBeenCalled();
  });

  it("リフレッシュトークンが既に失効済み → 200", async () => {
    const opaqueToken = "revoked-token";
    const revokedToken = { ...mockRefreshToken, revoked_at: "2024-06-01T00:00:00Z" };
    vi.mocked(authenticateService).mockResolvedValue(mockService);
    vi.mocked(parseTokenBody).mockResolvedValue({ token: opaqueToken });
    vi.mocked(sha256).mockResolvedValue("hashed-revoked");
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(revokedToken);

    const app = buildApp();
    const res = await sendRevoke(
      app,
      { token: opaqueToken },
      makeBasicAuth("test-client", "secret"),
    );

    expect(res.status).toBe(200);
    expect(revokeRefreshToken).not.toHaveBeenCalled();
  });

  it("リフレッシュトークンのサービスID不一致 → 200（revokeRefreshToken は呼ばれない）", async () => {
    const opaqueToken = "other-service-token";
    const otherServiceToken = { ...mockRefreshToken, service_id: "other-svc" };
    vi.mocked(authenticateService).mockResolvedValue(mockService);
    vi.mocked(parseTokenBody).mockResolvedValue({ token: opaqueToken });
    vi.mocked(sha256).mockResolvedValue("hashed-other");
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(otherServiceToken);

    const app = buildApp();
    const res = await sendRevoke(
      app,
      { token: opaqueToken },
      makeBasicAuth("test-client", "secret"),
    );

    expect(res.status).toBe(200);
    expect(revokeRefreshToken).not.toHaveBeenCalled();
  });

  // --- エラーハンドリング ---

  it("リフレッシュトークンDB処理エラー → 500 + server_error", async () => {
    const opaqueToken = "db-error-token";
    vi.mocked(authenticateService).mockResolvedValue(mockService);
    vi.mocked(parseTokenBody).mockResolvedValue({ token: opaqueToken });
    vi.mocked(sha256).mockResolvedValue("hashed-err");
    vi.mocked(findRefreshTokenByHash).mockRejectedValue(new Error("DB connection lost"));

    const app = buildApp();
    const res = await sendRevoke(
      app,
      { token: opaqueToken },
      makeBasicAuth("test-client", "secret"),
    );

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: "server_error" });
  });

  it("addRevokedAccessToken がエラー → 500 + server_error", async () => {
    const jwtToken = "header.payload.signature";
    vi.mocked(authenticateService).mockResolvedValue(mockService);
    vi.mocked(parseTokenBody).mockResolvedValue({ token: jwtToken });
    vi.mocked(verifyAccessToken).mockResolvedValue(mockPayload);
    vi.mocked(addRevokedAccessToken).mockRejectedValue(new Error("KV write failed"));

    const app = buildApp();
    const res = await sendRevoke(app, { token: jwtToken }, makeBasicAuth("test-client", "secret"));

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: "server_error" });
  });
});
