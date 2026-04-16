import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";

// @0g0-id/shared の全関数をモック
vi.mock("@0g0-id/shared", () => ({
  createLogger: vi
    .fn()
    .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  sha256: vi.fn(),
  findServiceByClientId: vi.fn(),
  findServiceById: vi.fn(),
  findUserById: vi.fn(),
  createDeviceCode: vi.fn(),
  findDeviceCodeByUserCode: vi.fn(),
  findDeviceCodeByHash: vi.fn(),
  approveDeviceCode: vi.fn(),
  denyDeviceCode: vi.fn(),
  tryUpdateDeviceCodePolledAt: vi.fn(),
  deleteDeviceCode: vi.fn(),
  deleteApprovedDeviceCode: vi.fn(),
  deleteExpiredDeviceCodes: vi.fn(),
  signIdToken: vi.fn(),
}));

// token-pair ユーティリティのモック
vi.mock("../utils/token-pair", () => ({
  issueTokenPair: vi.fn(),
  buildTokenResponse: vi.fn(),
  issueIdToken: vi.fn(),
}));

// scopes ユーティリティのモック
vi.mock("../utils/scopes", () => ({
  parseAllowedScopes: vi.fn((s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return [];
    }
  }),
  resolveEffectiveScope: vi.fn((scope: string | null) => scope ?? "openid"),
}));

// middleware のモック（device.ts が参照するが handleDeviceCodeGrant では不使用）
vi.mock("../middleware/rate-limit", () => ({
  tokenApiRateLimitMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  deviceVerifyRateLimitMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));
vi.mock("../middleware/auth", () => ({
  authMiddleware: vi.fn(
    (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      c.set("user", { sub: "user-1", email: "test@example.com", name: "Test User" });
      return next();
    },
  ),
  rejectServiceTokenMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  rejectBannedUserMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));

import {
  sha256,
  findServiceByClientId,
  findServiceById,
  findUserById,
  findDeviceCodeByHash,
  findDeviceCodeByUserCode,
  tryUpdateDeviceCodePolledAt,
  deleteApprovedDeviceCode,
  approveDeviceCode,
  denyDeviceCode,
  createDeviceCode,
  deleteExpiredDeviceCodes,
} from "@0g0-id/shared";
import { parseAllowedScopes } from "../utils/scopes";

import { issueTokenPair, buildTokenResponse, issueIdToken } from "../utils/token-pair";
import { resolveEffectiveScope } from "../utils/scopes";
import { createMockIdpEnv } from "../../../../packages/shared/src/db/test-helpers";

import deviceRoutes, { handleDeviceCodeGrant } from "./device";

// IdpEnv の必須フィールドをすべて含むモック環境
const mockEnv = createMockIdpEnv({
  GOOGLE_CLIENT_ID: "mock-google-client-id",
  GOOGLE_CLIENT_SECRET: "mock-google-client-secret",
});

// テスト用 context ファクトリ
function makeContext() {
  return {
    env: mockEnv,
    req: {
      header: vi.fn().mockReturnValue(undefined),
    },
    json: vi.fn((data: unknown, status?: number, headers?: Record<string, string>) => {
      const responseHeaders = new Headers({ "Content-Type": "application/json" });
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          responseHeaders.set(k, v);
        }
      }
      return new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: responseHeaders,
      });
    }),
  };
}

const mockService = {
  id: "service-1",
  name: "Test Service",
  client_id: "test-client-id",
  client_secret_hash: "hashed-secret",
  allowed_scopes: JSON.stringify(["profile", "email"]),
  owner_user_id: "admin-user-id",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const mockUser = {
  id: "user-1",
  google_sub: "google-sub-1",
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: "test@example.com",
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

const mockDeviceCode = {
  id: "dc-id",
  device_code_hash: "hashed-device-code",
  user_code: "ABCDEFGH",
  service_id: "service-1",
  user_id: null as string | null,
  scope: null as string | null,
  approved_at: null as string | null,
  denied_at: null as string | null,
  expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  polled_at: null as string | null,
  created_at: "2024-01-01T00:00:00Z",
};

const approvedDeviceCode = {
  ...mockDeviceCode,
  approved_at: "2024-01-01T00:00:00Z",
  user_id: "user-1",
  scope: "openid profile",
};

const baseParams = {
  device_code: "raw-device-code",
  client_id: "test-client-id",
  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
};

beforeEach(() => {
  vi.clearAllMocks();
  // デフォルトのモック設定
  vi.mocked(sha256).mockResolvedValue("hashed-device-code");
  vi.mocked(findServiceByClientId).mockResolvedValue(mockService as never);
  vi.mocked(findDeviceCodeByHash).mockResolvedValue(mockDeviceCode as never);
  vi.mocked(tryUpdateDeviceCodePolledAt).mockResolvedValue(true);
  vi.mocked(findUserById).mockResolvedValue(mockUser as never);
  vi.mocked(deleteApprovedDeviceCode).mockResolvedValue(true);
  vi.mocked(resolveEffectiveScope).mockReturnValue("openid profile");
  vi.mocked(issueTokenPair).mockResolvedValue({
    accessToken: "mock-access-token",
    refreshToken: "mock-refresh-token",
  } as never);
  vi.mocked(buildTokenResponse).mockReturnValue({
    access_token: "mock-access-token",
    refresh_token: "mock-refresh-token",
    token_type: "Bearer",
    expires_in: 900,
  } as never);
});

// ===== handleDeviceCodeGrant =====
describe("handleDeviceCodeGrant", () => {
  it("device_code 未指定 → invalid_request + 400", async () => {
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, { client_id: "test-client-id" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("client_id 未指定 → invalid_request + 400", async () => {
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, { device_code: "raw-device-code" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("クライアント不存在 → invalid_client + 401", async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(null);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });

  it("デバイスコード不存在 → invalid_grant + 400", async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(null);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("別サービスのデバイスコード → invalid_grant + 400", async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue({
      ...mockDeviceCode,
      service_id: "other-service-id",
    } as never);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("期限切れデバイスコード → expired_token + 400", async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue({
      ...mockDeviceCode,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    } as never);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("expired_token");
  });

  it("拒否済みデバイスコード → access_denied + 400", async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue({
      ...mockDeviceCode,
      denied_at: "2024-01-01T00:00:00Z",
    } as never);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("access_denied");
  });

  // ===== slow_down / Retry-After =====
  it("ポーリング間隔超過 → slow_down + 400", async () => {
    vi.mocked(tryUpdateDeviceCodePolledAt).mockResolvedValue(false);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("slow_down");
  });

  it("RFC 8628 §3.5: slow_down レスポンスに Retry-After ヘッダーが含まれる", async () => {
    vi.mocked(tryUpdateDeviceCodePolledAt).mockResolvedValue(false);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    // Retry-After ヘッダーにポーリング間隔の2倍（10秒）が設定されていること
    expect(res.headers.get("Retry-After")).toBe("10");
  });

  it("authorization_pending には Retry-After ヘッダーが含まれない", async () => {
    // tryUpdateDeviceCodePolledAt が true → まだ承認されていない（authorization_pending）
    vi.mocked(tryUpdateDeviceCodePolledAt).mockResolvedValue(true);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("authorization_pending");
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("未承認 → authorization_pending + 400", async () => {
    vi.mocked(tryUpdateDeviceCodePolledAt).mockResolvedValue(true);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("authorization_pending");
  });

  // ===== 承認後のケース =====
  it("承認済みだがユーザー不存在 → invalid_grant + 400", async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(approvedDeviceCode as never);
    vi.mocked(findUserById).mockResolvedValue(null);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("BAN済みユーザー → access_denied + 403", async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(approvedDeviceCode as never);
    vi.mocked(findUserById).mockResolvedValue({
      ...mockUser,
      banned_at: "2024-01-01T00:00:00Z",
    } as never);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("access_denied");
  });

  it("二重消費（deleteApprovedDeviceCode が false） → invalid_grant + 400", async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(approvedDeviceCode as never);
    vi.mocked(deleteApprovedDeviceCode).mockResolvedValue(false);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("承認済み → トークンレスポンスを返す", async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(approvedDeviceCode as never);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; token_type: string };
    expect(body.access_token).toBe("mock-access-token");
    expect(body.token_type).toBe("Bearer");
  });

  it("承認済み（openid スコープあり）→ issueIdToken が呼ばれる", async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(approvedDeviceCode as never);
    vi.mocked(issueIdToken).mockResolvedValue("mock-id-token");
    vi.mocked(resolveEffectiveScope).mockReturnValue("openid profile");
    const c = makeContext();
    await handleDeviceCodeGrant(c as never, baseParams);
    expect(issueIdToken).toHaveBeenCalled();
  });

  it("全スコープが無効（resolveEffectiveScope → undefined）→ invalid_scope + 400", async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(approvedDeviceCode as never);
    vi.mocked(resolveEffectiveScope).mockReturnValue(undefined as never);
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_scope");
    expect(body.error_description).toBe("No valid scope");
    // issueTokenPair は呼ばれないこと
    expect(issueTokenPair).not.toHaveBeenCalled();
  });

  // ===== DB エラー =====
  it("findServiceByClientId DB エラー → server_error + 500", async () => {
    vi.mocked(findServiceByClientId).mockRejectedValue(new Error("DB error"));
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("server_error");
  });

  it("findDeviceCodeByHash DB エラー → server_error + 500", async () => {
    vi.mocked(findDeviceCodeByHash).mockRejectedValue(new Error("DB error"));
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("server_error");
  });

  it("tryUpdateDeviceCodePolledAt DB エラー → server_error + 500", async () => {
    vi.mocked(tryUpdateDeviceCodePolledAt).mockRejectedValue(new Error("DB error"));
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("server_error");
  });

  it("findUserById DB エラー（承認済みコード）→ server_error + 500", async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(approvedDeviceCode as never);
    vi.mocked(findUserById).mockRejectedValue(new Error("DB error"));
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("server_error");
  });

  it("deleteApprovedDeviceCode DB エラー → server_error + 500", async () => {
    vi.mocked(findDeviceCodeByHash).mockResolvedValue(approvedDeviceCode as never);
    vi.mocked(deleteApprovedDeviceCode).mockRejectedValue(new Error("DB error"));
    const c = makeContext();
    const res = await handleDeviceCodeGrant(c as never, baseParams);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("server_error");
  });
});

// ===== POST /api/device/code — デバイス認可リクエスト =====
describe("POST /api/device/code — デバイス認可リクエスト", () => {
  const baseUrl = "https://id.0g0.xyz";

  function buildDeviceApp() {
    const app = new Hono<{ Bindings: typeof mockEnv }>();
    app.route("/api/device", deviceRoutes);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findServiceByClientId).mockResolvedValue(mockService as never);
    vi.mocked(resolveEffectiveScope).mockImplementation((scope) => scope ?? "openid");
    vi.mocked(createDeviceCode).mockResolvedValue(undefined as never);
    // deleteExpiredDeviceCodes は fire-and-forget なので Promise を返す必要がある
    vi.mocked(deleteExpiredDeviceCodes).mockResolvedValue(undefined as never);
  });

  it("client_id 未指定 → invalid_request + 400", async () => {
    const app = buildDeviceApp();
    const body = new URLSearchParams({ scope: "openid" });
    const res = await app.request(
      new Request(`${baseUrl}/api/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("invalid_request");
  });

  it("不明な client_id → invalid_client + 401", async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(null);
    const app = buildDeviceApp();
    const body = new URLSearchParams({ client_id: "unknown-client" });
    const res = await app.request(
      new Request(`${baseUrl}/api/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(401);
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("invalid_client");
  });

  it("DB エラー (findServiceByClientId) → server_error + 500", async () => {
    vi.mocked(findServiceByClientId).mockRejectedValue(new Error("DB error"));
    const app = buildDeviceApp();
    const body = new URLSearchParams({ client_id: "test-client-id" });
    const res = await app.request(
      new Request(`${baseUrl}/api/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(500);
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("server_error");
  });

  it("未対応の Content-Type → invalid_request + 400", async () => {
    const app = buildDeviceApp();
    const res = await app.request(
      new Request(`${baseUrl}/api/device/code`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "client_id=test",
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("invalid_request");
  });

  it("JSON Content-Type でも発行できる", async () => {
    vi.mocked(resolveEffectiveScope).mockReturnValue("openid");
    const app = buildDeviceApp();
    const res = await app.request(
      new Request(`${baseUrl}/api/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "test-client-id" }),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
  });

  it("全スコープが無効 → { error: invalid_scope } + 400", async () => {
    // resolveEffectiveScope が undefined を返す（全スコープ無効）
    vi.mocked(resolveEffectiveScope).mockReturnValue(undefined);
    const app = buildDeviceApp();
    const body = new URLSearchParams({
      client_id: "test-client-id",
      scope: "address",
    });
    const res = await app.request(
      new Request(`${baseUrl}/api/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json<{ error: string; error_description: string }>();
    expect(json.error).toBe("invalid_scope");
  });

  it("有効なスコープ → デバイスコードを発行して 200", async () => {
    vi.mocked(resolveEffectiveScope).mockReturnValue("openid profile");
    const app = buildDeviceApp();
    const body = new URLSearchParams({
      client_id: "test-client-id",
      scope: "openid profile",
    });
    const res = await app.request(
      new Request(`${baseUrl}/api/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }>();
    expect(json.device_code).toBeTruthy();
    expect(json.user_code).toBeTruthy();
    expect(json.verification_uri).toBe("https://user.0g0.xyz/device");
    expect(json.expires_in).toBe(600);
    expect(json.interval).toBe(5);
  });

  it("user_code の形式が XXXX-XXXX", async () => {
    vi.mocked(resolveEffectiveScope).mockReturnValue("openid");
    const app = buildDeviceApp();
    const body = new URLSearchParams({ client_id: "test-client-id" });
    const res = await app.request(
      new Request(`${baseUrl}/api/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json<{ user_code: string }>();
    expect(json.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });
});

// ===== POST /api/device/verify — デバイスコード承認/拒否 =====
describe("POST /api/device/verify", () => {
  const baseUrl = "https://id.0g0.xyz";

  function buildDeviceApp() {
    const app = new Hono<{ Bindings: typeof mockEnv }>();
    app.route("/api/device", deviceRoutes);
    return app;
  }

  const validUserCode = "ABCD-EFGH"; // ハイフン付き → 正規化後 ABCDEFGH
  const normalizedUserCode = "ABCDEFGH";

  const mockDeviceCodeForVerify = {
    id: "dc-verify-id",
    device_code_hash: "hashed-device-code",
    user_code: normalizedUserCode,
    service_id: "service-1",
    user_id: null as string | null,
    scope: "openid profile" as string | null,
    approved_at: null as string | null,
    denied_at: null as string | null,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    polled_at: null as string | null,
    created_at: "2024-01-01T00:00:00Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findDeviceCodeByUserCode).mockResolvedValue(mockDeviceCodeForVerify as never);
    vi.mocked(findServiceById).mockResolvedValue(mockService as never);
    vi.mocked(approveDeviceCode).mockResolvedValue(undefined as never);
    vi.mocked(denyDeviceCode).mockResolvedValue(undefined as never);
    vi.mocked(parseAllowedScopes).mockReturnValue(["openid", "profile"] as never);
  });

  async function postVerify(body: Record<string, unknown>) {
    const app = buildDeviceApp();
    return app.request(
      new Request(`${baseUrl}/api/device/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      undefined,
      mockEnv,
    );
  }

  // 1. ボディパース失敗 → 400 BAD_REQUEST
  it("ボディパース失敗 → 400 BAD_REQUEST", async () => {
    const app = buildDeviceApp();
    const res = await app.request(
      new Request(`${baseUrl}/api/device/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json{{{",
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe("BAD_REQUEST");
  });

  // 2. user_code 未指定 → 400 BAD_REQUEST
  it("user_code 未指定 → 400 BAD_REQUEST", async () => {
    const res = await postVerify({});
    expect(res.status).toBe(400);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe("BAD_REQUEST");
  });

  // 3. action 不正値（"cancel"）→ 400 BAD_REQUEST（早期バリデーション）
  it("action 不正値 → 400 BAD_REQUEST（DBアクセス前に弾く）", async () => {
    const res = await postVerify({ user_code: validUserCode, action: "cancel" });
    expect(res.status).toBe(400);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe("BAD_REQUEST");
    // 不正なactionは早期バリデーションで弾かれるため、DBアクセスは不要
    expect(findDeviceCodeByUserCode).not.toHaveBeenCalled();
  });

  // 4. user_code フォーマット不正 → 400 BAD_REQUEST
  it("user_code フォーマット不正 → 400 BAD_REQUEST", async () => {
    const res = await postVerify({ user_code: "INVALID!" });
    expect(res.status).toBe(400);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe("BAD_REQUEST");
  });

  // 5. user_code 不存在 → 404 INVALID_CODE
  it("user_code 不存在 → 404 INVALID_CODE", async () => {
    vi.mocked(findDeviceCodeByUserCode).mockResolvedValue(null);
    const res = await postVerify({ user_code: validUserCode });
    expect(res.status).toBe(404);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe("INVALID_CODE");
  });

  // 6. 期限切れ → 400 CODE_EXPIRED
  it("期限切れ → 400 CODE_EXPIRED", async () => {
    vi.mocked(findDeviceCodeByUserCode).mockResolvedValue({
      ...mockDeviceCodeForVerify,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    } as never);
    const res = await postVerify({ user_code: validUserCode });
    expect(res.status).toBe(400);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe("CODE_EXPIRED");
  });

  // 7. 承認済み状態（approved_at 設定済み）→ 400 CODE_ALREADY_USED
  it("承認済み状態 → 400 CODE_ALREADY_USED", async () => {
    vi.mocked(findDeviceCodeByUserCode).mockResolvedValue({
      ...mockDeviceCodeForVerify,
      approved_at: "2024-01-01T00:00:00Z",
      user_id: "user-1",
    } as never);
    const res = await postVerify({ user_code: validUserCode });
    expect(res.status).toBe(400);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe("CODE_ALREADY_USED");
  });

  // 8. 拒否済み状態（denied_at 設定済み）→ 400 CODE_ALREADY_USED
  it("拒否済み状態 → 400 CODE_ALREADY_USED", async () => {
    vi.mocked(findDeviceCodeByUserCode).mockResolvedValue({
      ...mockDeviceCodeForVerify,
      denied_at: "2024-01-01T00:00:00Z",
    } as never);
    const res = await postVerify({ user_code: validUserCode });
    expect(res.status).toBe(400);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe("CODE_ALREADY_USED");
  });

  // 9. action なし（情報取得）→ 200 { data: { service_name, scopes } }
  it("action なし → 200 サービス情報を返す", async () => {
    const res = await postVerify({ user_code: validUserCode });
    expect(res.status).toBe(200);
    const json = await res.json<{ data: { service_name: string; scopes: string[] } }>();
    expect(json.data.service_name).toBe("Test Service");
    expect(Array.isArray(json.data.scopes)).toBe(true);
  });

  // 10. action = "approve" → 200 { status: "approved" }
  it('action = "approve" → 200 approved', async () => {
    const res = await postVerify({ user_code: validUserCode, action: "approve" });
    expect(res.status).toBe(200);
    const json = await res.json<{ status: string }>();
    expect(json.status).toBe("approved");
    expect(approveDeviceCode).toHaveBeenCalledWith(
      mockEnv.DB,
      mockDeviceCodeForVerify.id,
      expect.any(String),
    );
  });

  // 11. action = "deny" → 200 { status: "denied" }
  it('action = "deny" → 200 denied', async () => {
    const res = await postVerify({ user_code: validUserCode, action: "deny" });
    expect(res.status).toBe(200);
    const json = await res.json<{ status: string }>();
    expect(json.status).toBe("denied");
    expect(denyDeviceCode).toHaveBeenCalledWith(mockEnv.DB, mockDeviceCodeForVerify.id);
  });

  // 12. ハイフン付き user_code の正規化（"ABCD-EFGH" → 正常処理）
  it("ハイフン付き user_code を正規化して正常処理", async () => {
    const res = await postVerify({ user_code: "ABCD-EFGH" });
    expect(res.status).toBe(200);
    // findDeviceCodeByUserCode には正規化後（ハイフンなし）の値が渡される
    expect(findDeviceCodeByUserCode).toHaveBeenCalledWith(mockEnv.DB, "ABCDEFGH");
  });

  // 13. findDeviceCodeByUserCode DB エラー → 500 INTERNAL_ERROR
  it("findDeviceCodeByUserCode DB エラー → 500 INTERNAL_ERROR", async () => {
    vi.mocked(findDeviceCodeByUserCode).mockRejectedValue(new Error("DB error"));
    const res = await postVerify({ user_code: validUserCode });
    expect(res.status).toBe(500);
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("INTERNAL_ERROR");
  });
});
