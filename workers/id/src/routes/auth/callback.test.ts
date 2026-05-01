import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

// --- モック定義 ---
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...original,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    timingSafeEqual: vi.fn(),
    findUserById: vi.fn(),
    tryBootstrapAdmin: vi.fn(),
    generateToken: vi.fn(),
    sha256: vi.fn(),
    createAuthCode: vi.fn(),
    insertLoginEvent: vi.fn(),
    isAccountLocked: vi.fn(),
    recordFailedAttempt: vi.fn(),
    resetFailedAttempts: vi.fn(),
    verifyCookie: vi.fn(),
    isValidProvider: vi.fn(),
    getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
  };
});

vi.mock("hono/cookie", async (importOriginal) => {
  const original = await importOriginal<typeof import("hono/cookie")>();
  return {
    ...original,
    getCookie: vi.fn(),
    deleteCookie: vi.fn(),
  };
});

// getClientIp は @0g0-id/shared のモック内で定義済み

vi.mock("../../utils/provider-resolution", () => ({
  resolveProvider: vi.fn(),
}));

vi.mock("../../utils/auth-helpers", () => ({
  CALLBACK_PATH: "/auth/callback",
  OAUTH_ERROR_MAP: {
    access_denied: "Access was denied",
    server_error: "Server error occurred",
  } as Record<string, string>,
  STATE_COOKIE: "__Host-oauth-state",
  PKCE_COOKIE: "__Host-oauth-pkce",
  parseStateFromCookie: vi.fn(),
  handleProviderLink: vi.fn(),
  validateProviderCredentials: vi.fn(),
  isAllowedRedirectTo: vi.fn(),
}));

import {
  timingSafeEqual,
  findUserById,
  tryBootstrapAdmin,
  generateToken,
  sha256,
  createAuthCode,
  insertLoginEvent,
  isAccountLocked,
  recordFailedAttempt,
  resetFailedAttempts,
  verifyCookie,
  isValidProvider,
} from "@0g0-id/shared";
import { getCookie } from "hono/cookie";
import { resolveProvider } from "../../utils/provider-resolution";
import {
  parseStateFromCookie,
  handleProviderLink,
  validateProviderCredentials,
  isAllowedRedirectTo,
} from "../../utils/auth-helpers";
import { handleCallback } from "./callback";

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

const mockStateData = {
  idState: "id-state-123",
  bffState: "bff-state-456",
  redirectTo: "https://user.0g0.xyz/callback",
  provider: "google" as const,
  serviceId: undefined,
  nonce: undefined,
  codeChallenge: undefined,
  codeChallengeMethod: undefined,
  scope: undefined,
};

// --- ヘルパー ---
function buildApp() {
  const app = new Hono<{ Bindings: ReturnType<typeof createMockIdpEnv> }>();
  app.get("/auth/callback", handleCallback);
  return app;
}

function makeRequest(params: Record<string, string>, cookies?: Record<string, string>) {
  const app = buildApp();
  const url = new URL("https://id.0g0.xyz/auth/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (cookies) {
    headers["Cookie"] = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  return app.request(new Request(url.toString(), { headers }), undefined, mockEnv);
}

/**
 * 正常系テスト向け: state/PKCE 検証〜プロバイダー解決まで全てパスするモックをセットアップ
 */
function setupSuccessPath(userOverride?: Partial<typeof mockUser>) {
  const user = { ...mockUser, ...userOverride };

  // state / PKCE Cookie
  vi.mocked(getCookie).mockImplementation((_c, name) => {
    if (name === "__Host-oauth-state") return "signed-state-cookie";
    if (name === "__Host-oauth-pkce") return "signed-pkce-cookie";
    return undefined;
  });
  vi.mocked(verifyCookie).mockResolvedValue("pkce-verifier-value");
  vi.mocked(parseStateFromCookie).mockResolvedValue(mockStateData);
  vi.mocked(timingSafeEqual).mockReturnValue(true);

  // provider validation
  vi.mocked(isValidProvider).mockReturnValue(true);
  vi.mocked(validateProviderCredentials).mockReturnValue({ ok: true } as never);

  // resolveProvider
  vi.mocked(resolveProvider).mockResolvedValue({
    ok: true,
    sub: "google-sub-1",
    upsert: vi.fn().mockResolvedValue(user),
  });

  // finalizeLogin
  vi.mocked(isAccountLocked).mockResolvedValue({
    locked: false,
    failedAttempts: 0,
    lockedUntil: null,
  });
  vi.mocked(insertLoginEvent).mockResolvedValue(undefined as never);
  vi.mocked(resetFailedAttempts).mockResolvedValue(undefined as never);
  vi.mocked(generateToken).mockReturnValue("auth-code-token");
  vi.mocked(sha256).mockResolvedValue("hashed-auth-code");
  vi.mocked(createAuthCode).mockResolvedValue(undefined as never);
  vi.mocked(isAllowedRedirectTo).mockReturnValue(true);
}

// --- テスト ---
describe("GET /auth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =====================
  // OAuth エラー委譲
  // =====================
  describe("OAuth エラー委譲（handleOAuthError）", () => {
    it("error クエリパラメータあり + state Cookie あり → リダイレクトでエラーを返す", async () => {
      vi.mocked(getCookie).mockReturnValue("signed-state-cookie");
      vi.mocked(parseStateFromCookie).mockResolvedValue(mockStateData);
      vi.mocked(isAllowedRedirectTo).mockReturnValue(true);

      const res = await makeRequest(
        { error: "access_denied" },
        { "__Host-oauth-state": "signed-state-cookie" },
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("error=access_denied");
      expect(location).toContain("state=bff-state-456");
    });

    it("error クエリパラメータあり + state Cookie なし → 400 JSON エラー", async () => {
      vi.mocked(getCookie).mockReturnValue(undefined);

      const res = await makeRequest({ error: "access_denied" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("OAUTH_ERROR");
    });

    it("不明な error コード → access_denied にフォールバック", async () => {
      vi.mocked(getCookie).mockReturnValue("signed-state-cookie");
      vi.mocked(parseStateFromCookie).mockResolvedValue(mockStateData);
      vi.mocked(isAllowedRedirectTo).mockReturnValue(true);

      const res = await makeRequest(
        { error: "unknown_error_code" },
        { "__Host-oauth-state": "signed-state-cookie" },
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("error=access_denied");
    });
  });

  // =====================
  // code / state 必須チェック
  // =====================
  describe("code / state 必須チェック", () => {
    it("code が欠落 → 400 BAD_REQUEST", async () => {
      const res = await makeRequest({ state: "some-state" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Missing code or state");
    });

    it("state が欠落 → 400 BAD_REQUEST", async () => {
      const res = await makeRequest({ code: "some-code" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Missing code or state");
    });
  });

  // =====================
  // validateCallbackState
  // =====================
  describe("state / PKCE Cookie 検証（validateCallbackState）", () => {
    it("state Cookie が欠落 → 400 Missing session cookies", async () => {
      vi.mocked(getCookie).mockReturnValue(undefined);

      const res = await makeRequest({ code: "auth-code", state: "id-state-123" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Missing session cookies");
    });

    it("PKCE Cookie 検証失敗 → 400 Invalid PKCE cookie", async () => {
      vi.mocked(getCookie).mockImplementation((_c, name) => {
        if (name === "__Host-oauth-state") return "signed-state-cookie";
        if (name === "__Host-oauth-pkce") return "signed-pkce-cookie";
        return undefined;
      });
      vi.mocked(verifyCookie).mockResolvedValue(null);

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Invalid PKCE cookie");
    });

    it("state Cookie 検証/パース失敗 → 400 Invalid state cookie", async () => {
      vi.mocked(getCookie).mockImplementation((_c, name) => {
        if (name === "__Host-oauth-state") return "signed-state-cookie";
        if (name === "__Host-oauth-pkce") return "signed-pkce-cookie";
        return undefined;
      });
      vi.mocked(verifyCookie).mockResolvedValue("pkce-verifier-value");
      vi.mocked(parseStateFromCookie).mockResolvedValue(null);

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Invalid state cookie");
    });

    it("state 不一致（timing-safe比較） → 400 State mismatch", async () => {
      vi.mocked(getCookie).mockImplementation((_c, name) => {
        if (name === "__Host-oauth-state") return "signed-state-cookie";
        if (name === "__Host-oauth-pkce") return "signed-pkce-cookie";
        return undefined;
      });
      vi.mocked(verifyCookie).mockResolvedValue("pkce-verifier-value");
      vi.mocked(parseStateFromCookie).mockResolvedValue(mockStateData);
      vi.mocked(timingSafeEqual).mockReturnValue(false);

      const res = await makeRequest(
        { code: "auth-code", state: "wrong-state" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("State mismatch");
    });
  });

  // =====================
  // validateProviderConfig
  // =====================
  describe("プロバイダー設定検証（validateProviderConfig）", () => {
    it("provider が無効 → 400 BAD_REQUEST", async () => {
      vi.mocked(getCookie).mockImplementation((_c, name) => {
        if (name === "__Host-oauth-state") return "signed-state-cookie";
        if (name === "__Host-oauth-pkce") return "signed-pkce-cookie";
        return undefined;
      });
      vi.mocked(verifyCookie).mockResolvedValue("pkce-verifier-value");
      vi.mocked(parseStateFromCookie).mockResolvedValue(mockStateData);
      vi.mocked(timingSafeEqual).mockReturnValue(true);
      vi.mocked(isValidProvider).mockReturnValue(false);

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("プロバイダー credentials が未設定 → 400", async () => {
      vi.mocked(getCookie).mockImplementation((_c, name) => {
        if (name === "__Host-oauth-state") return "signed-state-cookie";
        if (name === "__Host-oauth-pkce") return "signed-pkce-cookie";
        return undefined;
      });
      vi.mocked(verifyCookie).mockResolvedValue("pkce-verifier-value");
      vi.mocked(parseStateFromCookie).mockResolvedValue(mockStateData);
      vi.mocked(timingSafeEqual).mockReturnValue(true);
      vi.mocked(isValidProvider).mockReturnValue(true);
      vi.mocked(validateProviderCredentials).mockReturnValue({
        ok: false,
        code: "BAD_REQUEST",
        message: "Missing credentials",
      } as never);

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // resolveProvider
  // =====================
  describe("プロバイダー解決（resolveProvider）", () => {
    it("resolveProvider 失敗 → エラーレスポンスを返す", async () => {
      vi.mocked(getCookie).mockImplementation((_c, name) => {
        if (name === "__Host-oauth-state") return "signed-state-cookie";
        if (name === "__Host-oauth-pkce") return "signed-pkce-cookie";
        return undefined;
      });
      vi.mocked(verifyCookie).mockResolvedValue("pkce-verifier-value");
      vi.mocked(parseStateFromCookie).mockResolvedValue(mockStateData);
      vi.mocked(timingSafeEqual).mockReturnValue(true);
      vi.mocked(isValidProvider).mockReturnValue(true);
      vi.mocked(validateProviderCredentials).mockReturnValue({ ok: true } as never);
      vi.mocked(resolveProvider).mockResolvedValue({
        ok: false,
        response: new Response(JSON.stringify({ error: { code: "OAUTH_ERROR" } }), { status: 400 }),
      });

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // resolveUserAccount (BAN)
  // =====================
  describe("ユーザーアカウント解決（resolveUserAccount）", () => {
    it("BAN されたユーザー → 403 ACCOUNT_BANNED", async () => {
      setupSuccessPath();
      // upsert が BAN ユーザーを返す
      vi.mocked(resolveProvider).mockResolvedValue({
        ok: true,
        sub: "google-sub-1",
        upsert: vi.fn().mockResolvedValue({ ...mockUser, banned_at: "2024-06-01T00:00:00Z" }),
      });

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("ACCOUNT_BANNED");
    });
  });

  // =====================
  // finalizeLogin
  // =====================
  describe("ログイン最終処理（finalizeLogin）", () => {
    it("アカウントロック → 429 ACCOUNT_LOCKED", async () => {
      setupSuccessPath();
      vi.mocked(isAccountLocked).mockResolvedValue({
        locked: true,
        lockedUntil: "2099-01-01T00:00:00Z",
        failedAttempts: 5,
      });

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(429);
      const body = await res.json<{ error: { code: string; locked_until: string } }>();
      expect(body.error.code).toBe("ACCOUNT_LOCKED");
      expect(body.error.locked_until).toBe("2099-01-01T00:00:00Z");
    });

    it("認可コード作成失敗 → 500 INTERNAL_ERROR", async () => {
      setupSuccessPath();
      vi.mocked(createAuthCode).mockRejectedValue(new Error("DB error"));

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(500);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });

    it("bootstrap admin 昇格失敗 → 500 INTERNAL_ERROR", async () => {
      const env = createMockIdpEnv({ BOOTSTRAP_ADMIN_EMAIL: "user@example.com" });
      setupSuccessPath();
      vi.mocked(tryBootstrapAdmin).mockRejectedValue(new Error("Elevation failed"));

      const app = new Hono<{ Bindings: ReturnType<typeof createMockIdpEnv> }>();
      app.get("/auth/callback", handleCallback);
      const url = new URL("https://id.0g0.xyz/auth/callback?code=auth-code&state=id-state-123");
      const res = await app.request(
        new Request(url.toString(), {
          headers: {
            Cookie: "__Host-oauth-state=signed-state-cookie; __Host-oauth-pkce=signed-pkce-cookie",
          },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(500);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });

    it("正常系 → 302 リダイレクト（code と state を含む）", async () => {
      setupSuccessPath();

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("code=auth-code-token");
      expect(location).toContain("state=bff-state-456");
      expect(location).toContain("https://user.0g0.xyz/callback");
    });

    it("正常系で failedAttempts > 0 → resetFailedAttempts が呼ばれる", async () => {
      setupSuccessPath();
      vi.mocked(isAccountLocked).mockResolvedValue({
        locked: false,
        failedAttempts: 3,
        lockedUntil: null,
      });

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(302);
      expect(vi.mocked(resetFailedAttempts)).toHaveBeenCalledWith(expect.anything(), "user-1");
    });

    it("リダイレクト URL が許可リストに含まれない → 400 BAD_REQUEST", async () => {
      setupSuccessPath();
      vi.mocked(isAllowedRedirectTo).mockReturnValue(false);

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Invalid redirect URL");
    });
  });

  // =====================
  // リンクフロー
  // =====================
  describe("プロバイダーリンクフロー", () => {
    it("linkUserId あり + ユーザー不在 → 404 NOT_FOUND", async () => {
      const linkStateData = { ...mockStateData, linkUserId: "link-user-1" };

      vi.mocked(getCookie).mockImplementation((_c, name) => {
        if (name === "__Host-oauth-state") return "signed-state-cookie";
        if (name === "__Host-oauth-pkce") return "signed-pkce-cookie";
        return undefined;
      });
      vi.mocked(verifyCookie).mockResolvedValue("pkce-verifier-value");
      vi.mocked(parseStateFromCookie).mockResolvedValue(linkStateData);
      vi.mocked(timingSafeEqual).mockReturnValue(true);
      vi.mocked(isValidProvider).mockReturnValue(true);
      vi.mocked(validateProviderCredentials).mockReturnValue({ ok: true } as never);
      vi.mocked(resolveProvider).mockResolvedValue({
        ok: true,
        sub: "google-sub-1",
        upsert: vi.fn(),
      });
      vi.mocked(findUserById).mockResolvedValue(null);

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(404);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("linkUserId あり + BAN ユーザー → 403 ACCOUNT_BANNED", async () => {
      const linkStateData = { ...mockStateData, linkUserId: "link-user-1" };

      vi.mocked(getCookie).mockImplementation((_c, name) => {
        if (name === "__Host-oauth-state") return "signed-state-cookie";
        if (name === "__Host-oauth-pkce") return "signed-pkce-cookie";
        return undefined;
      });
      vi.mocked(verifyCookie).mockResolvedValue("pkce-verifier-value");
      vi.mocked(parseStateFromCookie).mockResolvedValue(linkStateData);
      vi.mocked(timingSafeEqual).mockReturnValue(true);
      vi.mocked(isValidProvider).mockReturnValue(true);
      vi.mocked(validateProviderCredentials).mockReturnValue({ ok: true } as never);
      vi.mocked(resolveProvider).mockResolvedValue({
        ok: true,
        sub: "google-sub-1",
        upsert: vi.fn(),
      });
      vi.mocked(findUserById).mockResolvedValue({
        ...mockUser,
        id: "link-user-1",
        banned_at: "2024-06-01T00:00:00Z",
      });
      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("ACCOUNT_BANNED");
      expect(recordFailedAttempt).not.toHaveBeenCalled();
    });

    it("linkUserId あり + プロバイダーが既に別ユーザーにリンク → 409 PROVIDER_ALREADY_LINKED", async () => {
      const linkStateData = { ...mockStateData, linkUserId: "link-user-1" };

      vi.mocked(getCookie).mockImplementation((_c, name) => {
        if (name === "__Host-oauth-state") return "signed-state-cookie";
        if (name === "__Host-oauth-pkce") return "signed-pkce-cookie";
        return undefined;
      });
      vi.mocked(verifyCookie).mockResolvedValue("pkce-verifier-value");
      vi.mocked(parseStateFromCookie).mockResolvedValue(linkStateData);
      vi.mocked(timingSafeEqual).mockReturnValue(true);
      vi.mocked(isValidProvider).mockReturnValue(true);
      vi.mocked(validateProviderCredentials).mockReturnValue({ ok: true } as never);
      vi.mocked(resolveProvider).mockResolvedValue({
        ok: true,
        sub: "google-sub-1",
        upsert: vi.fn(),
      });
      vi.mocked(findUserById).mockResolvedValue({ ...mockUser, id: "link-user-1" });
      vi.mocked(handleProviderLink).mockResolvedValue({ ok: false } as never);

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(409);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("PROVIDER_ALREADY_LINKED");
    });
  });
});
