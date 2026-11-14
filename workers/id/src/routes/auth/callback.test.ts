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
    findResourceServerByUri: vi.fn(),
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

vi.mock("./social-callback", () => ({
  handleSocialCallback: vi.fn(),
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
  validateServiceFinalRedirect: vi.fn(),
}));

import {
  timingSafeEqual,
  findUserById,
  findResourceServerByUri,
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
import { deleteCookie, getCookie } from "hono/cookie";
import { resolveProvider } from "../../utils/provider-resolution";
import {
  parseStateFromCookie,
  handleProviderLink,
  validateProviderCredentials,
  isAllowedRedirectTo,
  validateServiceFinalRedirect,
} from "../../utils/auth-helpers";
import { handleCallback } from "./callback";
import { handleSocialCallback } from "./social-callback";
import { finalizeLogin, type LoginFinalizationState } from "./finalize";
import type { TokenPayload } from "@0g0-id/shared";

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

/** 現行の Cookie 削除は state → PKCE の順で、path と secure を固定している。 */
function expectOAuthCookiesCleared() {
  expect(vi.mocked(deleteCookie).mock.calls).toEqual([
    [expect.anything(), "__Host-oauth-state", { path: "/", secure: true }],
    [expect.anything(), "__Host-oauth-pkce", { path: "/", secure: true }],
  ]);
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
  const upsert = vi.fn().mockResolvedValue(user);
  vi.mocked(resolveProvider).mockResolvedValue({
    ok: true,
    sub: "google-sub-1",
    upsert,
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
  return { user, upsert };
}

// --- テスト ---
describe("GET /auth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(handleSocialCallback).mockReset();
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

    it("service フロー + 外部 callback 登録済み → BFF チェックを使わず登録 URI へエラーを返す", async () => {
      vi.mocked(getCookie).mockReturnValue("signed-state-cookie");
      vi.mocked(parseStateFromCookie).mockResolvedValue({
        ...mockStateData,
        serviceId: "svc-1",
        redirectTo: "https://chatgpt.com/connector/oauth/callback",
      });
      vi.mocked(validateServiceFinalRedirect).mockResolvedValue(true);
      // BFF 向けチェックでは落ちるドメインでも service フローでは使わない
      vi.mocked(isAllowedRedirectTo).mockReturnValue(false);

      const res = await makeRequest(
        { error: "access_denied" },
        { "__Host-oauth-state": "signed-state-cookie" },
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("https://chatgpt.com/connector/oauth/callback");
      expect(location).toContain("error=access_denied");
      expect(location).toContain("error_description=Access+was+denied");
      expect(location).toContain("state=bff-state-456");
      expect(vi.mocked(validateServiceFinalRedirect)).toHaveBeenCalledWith(
        mockEnv.DB,
        "svc-1",
        "https://chatgpt.com/connector/oauth/callback",
      );
    });

    it("service フロー + loopback callback 登録済み → loopback へエラーを返す", async () => {
      vi.mocked(getCookie).mockReturnValue("signed-state-cookie");
      vi.mocked(parseStateFromCookie).mockResolvedValue({
        ...mockStateData,
        serviceId: "svc-1",
        redirectTo: "http://localhost:8080/callback",
      });
      vi.mocked(validateServiceFinalRedirect).mockResolvedValue(true);
      vi.mocked(isAllowedRedirectTo).mockReturnValue(false);

      const res = await makeRequest(
        { error: "access_denied" },
        { "__Host-oauth-state": "signed-state-cookie" },
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("http://localhost:8080/callback");
      expect(location).toContain("error=access_denied");
      expect(location).toContain("state=bff-state-456");
    });

    it("service フロー + redirect が登録 URI と一致しない → 400（オープンリダイレクトにしない）", async () => {
      vi.mocked(getCookie).mockReturnValue("signed-state-cookie");
      vi.mocked(parseStateFromCookie).mockResolvedValue({
        ...mockStateData,
        serviceId: "svc-1",
        redirectTo: "https://evil.example/callback",
      });
      vi.mocked(validateServiceFinalRedirect).mockResolvedValue(false);
      vi.mocked(isAllowedRedirectTo).mockReturnValue(true);

      const res = await makeRequest(
        { error: "access_denied" },
        { "__Host-oauth-state": "signed-state-cookie" },
      );
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("OAUTH_ERROR");
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
      expectOAuthCookiesCleared();
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
      expect(deleteCookie).not.toHaveBeenCalled();
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
      expectOAuthCookiesCleared();
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
      expectOAuthCookiesCleared();
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
      expectOAuthCookiesCleared();
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
  // service 付きフローの最終リダイレクト確認
  // =====================
  describe("service 付きフロー（finalizeLogin）", () => {
    const serviceStateData = {
      ...mockStateData,
      serviceId: "svc-1",
      redirectTo: "https://chatgpt.com/connector/oauth/callback",
    };

    it("外部 HTTPS callback（登録済み）→ BFF チェックを使わず 302 で通る", async () => {
      setupSuccessPath();
      vi.mocked(parseStateFromCookie).mockResolvedValue(serviceStateData);
      vi.mocked(validateServiceFinalRedirect).mockResolvedValue(true);
      // BFF 向けチェックなら落ちるドメインでも、service フローでは使わない
      vi.mocked(isAllowedRedirectTo).mockReturnValue(false);

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("https://chatgpt.com/connector/oauth/callback");
      expect(location).toContain("code=auth-code-token");
      expect(vi.mocked(validateServiceFinalRedirect)).toHaveBeenCalledWith(
        mockEnv.DB,
        "svc-1",
        "https://chatgpt.com/connector/oauth/callback",
      );
    });

    it("loopback http callback（登録済み）→ 302 で通る", async () => {
      setupSuccessPath();
      vi.mocked(parseStateFromCookie).mockResolvedValue({
        ...serviceStateData,
        redirectTo: "http://localhost:8080/callback",
      });
      vi.mocked(validateServiceFinalRedirect).mockResolvedValue(true);

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("http://localhost:8080/callback");
    });

    it("service の登録 URI と一致しない → 400 BAD_REQUEST", async () => {
      setupSuccessPath();
      vi.mocked(parseStateFromCookie).mockResolvedValue(serviceStateData);
      vi.mocked(validateServiceFinalRedirect).mockResolvedValue(false);

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
  // resource 付きフローの subject 照合（認可段階）
  // =====================
  describe("resource 付きフロー（finalizeLogin）", () => {
    const RESOURCE_URI = "https://dots-events.0g0.xyz/mcp";
    const resourceStateData = {
      ...mockStateData,
      serviceId: "svc-1",
      redirectTo: "https://chatgpt.com/connector/oauth/callback",
      resource: RESOURCE_URI,
    };
    const baseResourceServer = {
      id: "rs-1",
      uri: RESOURCE_URI,
      name: "dots-events",
      allowed_scopes: '["events:read","events:subscribe"]',
      owner_user_id: "admin-1",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };

    it("利用者制限で許可されていない subject → 検証済み redirect へ access_denied を返す（コードを発行しない）", async () => {
      setupSuccessPath();
      vi.mocked(parseStateFromCookie).mockResolvedValue(resourceStateData);
      vi.mocked(findResourceServerByUri).mockResolvedValue({
        ...baseResourceServer,
        allowed_subjects: '["someone-else"]',
      });
      vi.mocked(validateServiceFinalRedirect).mockResolvedValue(true);

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("https://chatgpt.com/connector/oauth/callback");
      expect(location).toContain("error=access_denied");
      expect(location).toContain("error_description=");
      expect(location).toContain("state=bff-state-456");
      expect(location).not.toContain("code=");
      expect(vi.mocked(createAuthCode)).not.toHaveBeenCalled();
    });

    it("利用者制限で許可された subject → コードを発行して 302", async () => {
      setupSuccessPath();
      vi.mocked(parseStateFromCookie).mockResolvedValue(resourceStateData);
      vi.mocked(findResourceServerByUri).mockResolvedValue({
        ...baseResourceServer,
        allowed_subjects: '["user-1"]',
      });
      vi.mocked(validateServiceFinalRedirect).mockResolvedValue(true);

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(302);
      expect(vi.mocked(createAuthCode)).toHaveBeenCalledWith(
        mockEnv.DB,
        // 検証した登録世代（rs-1）がコードに固定される
        expect.objectContaining({ resource: RESOURCE_URI, resourceServerId: "rs-1" }),
      );
    });

    it("resource 登録が削除済み → 検証済み redirect へ invalid_target を返す（コードを発行しない）", async () => {
      setupSuccessPath();
      vi.mocked(parseStateFromCookie).mockResolvedValue(resourceStateData);
      vi.mocked(findResourceServerByUri).mockResolvedValue(null);
      vi.mocked(validateServiceFinalRedirect).mockResolvedValue(true);

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("https://chatgpt.com/connector/oauth/callback");
      expect(location).toContain("error=invalid_target");
      expect(location).toContain("error_description=Resource+is+no+longer+registered");
      expect(location).toContain("state=bff-state-456");
      expect(vi.mocked(createAuthCode)).not.toHaveBeenCalled();
    });

    it("resource 登録が削除済み + redirect 未検証 → 400（オープンリダイレクトにしない）", async () => {
      setupSuccessPath();
      vi.mocked(parseStateFromCookie).mockResolvedValue(resourceStateData);
      vi.mocked(findResourceServerByUri).mockResolvedValue(null);
      vi.mocked(validateServiceFinalRedirect).mockResolvedValue(false);

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
      expect(vi.mocked(createAuthCode)).not.toHaveBeenCalled();
    });

    it("BFF フロー + 利用者制限で許可されていない subject → BFF の戻り先へ access_denied を返す", async () => {
      setupSuccessPath();
      vi.mocked(parseStateFromCookie).mockResolvedValue({
        ...mockStateData,
        resource: RESOURCE_URI,
      });
      vi.mocked(findResourceServerByUri).mockResolvedValue({
        ...baseResourceServer,
        allowed_subjects: '["someone-else"]',
      });

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("https://user.0g0.xyz/callback");
      expect(location).toContain("error=access_denied");
      expect(location).toContain("state=bff-state-456");
      expect(vi.mocked(createAuthCode)).not.toHaveBeenCalled();
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
      expect(handleProviderLink).not.toHaveBeenCalled();
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
      expect(handleProviderLink).not.toHaveBeenCalled();
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

    it("linkUserId あり + リンク成功 → upsert せず既存ユーザーで 302", async () => {
      const { upsert } = setupSuccessPath();
      vi.mocked(parseStateFromCookie).mockResolvedValue({
        ...mockStateData,
        linkUserId: "link-user-1",
      });
      vi.mocked(findUserById).mockResolvedValue({ ...mockUser, id: "link-user-1" });
      vi.mocked(handleProviderLink).mockResolvedValue({
        ok: true,
        user: { ...mockUser, id: "link-user-1" },
      });

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(302);
      expect(upsert).not.toHaveBeenCalled();
      expect(handleProviderLink).toHaveBeenCalledWith(
        mockEnv.DB,
        "link-user-1",
        "google",
        "google-sub-1",
      );
      expect(createAuthCode).toHaveBeenCalledWith(
        mockEnv.DB,
        expect.objectContaining({ userId: "link-user-1" }),
      );
    });

    it("リンク後のユーザーが BAN → 403 ACCOUNT_BANNED（コードは発行しない）", async () => {
      const { upsert } = setupSuccessPath();
      vi.mocked(parseStateFromCookie).mockResolvedValue({
        ...mockStateData,
        linkUserId: "link-user-1",
      });
      vi.mocked(findUserById).mockResolvedValue({ ...mockUser, id: "link-user-1" });
      vi.mocked(handleProviderLink).mockResolvedValue({
        ok: true,
        user: { ...mockUser, id: "link-user-1", banned_at: "2024-06-01T00:00:00Z" },
      });

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error).toEqual({
        code: "ACCOUNT_BANNED",
        message: "Your account has been suspended",
      });
      expect(upsert).not.toHaveBeenCalled();
      expect(handleProviderLink).toHaveBeenCalledOnce();
      expect(createAuthCode).not.toHaveBeenCalled();
    });
  });

  describe("薄い成功・失敗経路の特徴", () => {
    it("discord の state は error と code より先にソーシャルコールバックへ委譲する", async () => {
      vi.mocked(handleSocialCallback).mockImplementation((c) =>
        Promise.resolve(c.json({ error: { code: "DELEGATED" } }, 418)),
      );
      vi.mocked(getCookie).mockImplementation((_c, name) =>
        name === "__Host-oauth-state" ? "signed-state-cookie" : undefined,
      );
      vi.mocked(parseStateFromCookie).mockResolvedValue({ ...mockStateData, provider: "discord" });

      const res = await makeRequest(
        { error: "access_denied", code: "auth-code", state: "id-state-123" },
        { "__Host-oauth-state": "signed-state-cookie" },
      );
      expect(res.status).toBe(418);
      expect(handleSocialCallback).toHaveBeenCalledOnce();
      expect(vi.mocked(handleSocialCallback).mock.calls[0]?.[1]).toBe("discord");
      expect(resolveProvider).not.toHaveBeenCalled();
      expect(deleteCookie).not.toHaveBeenCalled();
    });

    it("steam の state を共通コールバックで受けても discord ハンドラへ委譲する", async () => {
      vi.mocked(handleSocialCallback).mockImplementation((c) =>
        Promise.resolve(c.json({ error: { code: "DELEGATED" } }, 418)),
      );
      vi.mocked(getCookie).mockImplementation((_c, name) =>
        name === "__Host-oauth-state" ? "signed-state-cookie" : undefined,
      );
      vi.mocked(parseStateFromCookie).mockResolvedValue({ ...mockStateData, provider: "steam" });

      const res = await makeRequest(
        { error: "access_denied", code: "auth-code", state: "id-state-123" },
        { "__Host-oauth-state": "signed-state-cookie" },
      );
      expect(res.status).toBe(418);
      expect(vi.mocked(handleSocialCallback).mock.calls[0]?.[1]).toBe("discord");
      expect(resolveProvider).not.toHaveBeenCalled();
    });

    it("通常プロバイダーで PKCE Cookie だけが無い → 検証も削除もせず Missing session cookies", async () => {
      vi.mocked(getCookie).mockImplementation((_c, name) =>
        name === "__Host-oauth-state" ? "signed-state-cookie" : undefined,
      );
      vi.mocked(parseStateFromCookie).mockResolvedValue(mockStateData);

      const res = await makeRequest({ code: "auth-code", state: "id-state-123" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error).toEqual({ code: "BAD_REQUEST", message: "Missing session cookies" });
      expect(verifyCookie).not.toHaveBeenCalled();
      expect(deleteCookie).not.toHaveBeenCalled();
    });

    it("state に provider が無い → Missing provider in state", async () => {
      setupSuccessPath();
      vi.mocked(parseStateFromCookie).mockResolvedValue({
        ...mockStateData,
        provider: undefined,
      } as unknown as typeof mockStateData);

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error).toEqual({ code: "BAD_REQUEST", message: "Missing provider in state" });
      expect(isValidProvider).not.toHaveBeenCalled();
      expect(resolveProvider).not.toHaveBeenCalled();
    });

    it("資格情報エラーの code と message をそのまま返す", async () => {
      setupSuccessPath();
      vi.mocked(validateProviderCredentials).mockReturnValue({
        ok: false,
        code: "PROVIDER_NOT_CONFIGURED",
        message: "Google provider is not configured",
      });

      const res = await makeRequest(
        { code: "auth-code", state: "id-state-123" },
        {
          "__Host-oauth-state": "signed-state-cookie",
          "__Host-oauth-pkce": "signed-pkce-cookie",
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error).toEqual({
        code: "PROVIDER_NOT_CONFIGURED",
        message: "Google provider is not configured",
      });
      expect(resolveProvider).not.toHaveBeenCalled();
    });

    it("Cookie が無い既知の error → マップされた JSON メッセージ", async () => {
      vi.mocked(getCookie).mockReturnValue(undefined);

      const res = await makeRequest({ error: "access_denied" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error).toEqual({ code: "OAUTH_ERROR", message: "Access was denied" });
      expectOAuthCookiesCleared();
    });

    it("Cookie が無い未知の error → Authentication failed", async () => {
      vi.mocked(getCookie).mockReturnValue(undefined);

      const res = await makeRequest({ error: "not_a_real_error" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error).toEqual({ code: "OAUTH_ERROR", message: "Authentication failed" });
    });

    it("state Cookie を解釈できない error → リダイレクトせず JSON", async () => {
      vi.mocked(getCookie).mockReturnValue("signed-state-cookie");
      vi.mocked(parseStateFromCookie).mockResolvedValue(null);

      const res = await makeRequest(
        { error: "server_error" },
        { "__Host-oauth-state": "signed-state-cookie" },
      );
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error).toEqual({ code: "OAUTH_ERROR", message: "Server error occurred" });
      expect(handleSocialCallback).not.toHaveBeenCalled();
      expectOAuthCookiesCleared();
    });

    it("BFF の戻り先が不許可な error → JSON のまま止める", async () => {
      vi.mocked(getCookie).mockReturnValue("signed-state-cookie");
      vi.mocked(parseStateFromCookie).mockResolvedValue(mockStateData);
      vi.mocked(isAllowedRedirectTo).mockReturnValue(false);

      const res = await makeRequest(
        { error: "access_denied" },
        { "__Host-oauth-state": "signed-state-cookie" },
      );
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error).toEqual({ code: "OAUTH_ERROR", message: "Access was denied" });
      expect(res.headers.get("Location")).toBeNull();
    });

    it("通常ログインは交換引数、Cookie 削除、UUID の順を保つ", async () => {
      const ids: string[] = [];
      const generate = crypto.randomUUID.bind(crypto);
      vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
        const id = generate();
        ids.push(id);
        return id;
      });
      try {
        const { upsert } = setupSuccessPath();
        const res = await makeRequest(
          { code: "auth-code", state: "id-state-123" },
          {
            "__Host-oauth-state": "signed-state-cookie",
            "__Host-oauth-pkce": "signed-pkce-cookie",
          },
        );
        expect(res.status).toBe(302);
        expect(handleSocialCallback).not.toHaveBeenCalled();
        expect(resolveProvider).toHaveBeenCalledWith(
          expect.anything(),
          "google",
          "auth-code",
          "pkce-verifier-value",
          "https://id.0g0.xyz/auth/callback",
        );
        expect(ids).toHaveLength(2);
        expect(upsert).toHaveBeenCalledWith(mockEnv.DB, ids[0]);
        expect(createAuthCode).toHaveBeenCalledWith(
          mockEnv.DB,
          expect.objectContaining({ id: ids[1], userId: mockUser.id }),
        );
        expectOAuthCookiesCleared();
      } finally {
        vi.mocked(crypto.randomUUID).mockRestore();
      }
    });
  });
});

describe("shared finalization after native passkey authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessPath();
  });
  const nativeState: LoginFinalizationState = {
    ...mockStateData,
    provider: "passkey",
    serviceId: "native-service",
    redirectTo: "https://app.example.test/callback",
    nonce: "native-nonce",
    codeChallenge: "A".repeat(43),
    codeChallengeMethod: "S256",
    scope: "openid profile",
  };
  function nativeRequest(state: LoginFinalizationState = nativeState) {
    const app = new Hono<{
      Bindings: ReturnType<typeof createMockIdpEnv>;
      Variables: { user: TokenPayload };
    }>();
    app.get("/native-finish", (c) => finalizeLogin(c, mockUser, "passkey", state));
    return app.request("https://id.0g0.xyz/native-finish", {}, mockEnv);
  }
  it("uses the existing standard code path with state/PKCE/nonce and a native method label", async () => {
    vi.mocked(validateServiceFinalRedirect).mockResolvedValue(true);
    const res = await nativeRequest();
    expect(res.status).toBe(302);
    expect(vi.mocked(createAuthCode)).toHaveBeenCalledWith(
      mockEnv.DB,
      expect.objectContaining({
        userId: mockUser.id,
        serviceId: "native-service",
        redirectTo: nativeState.redirectTo,
        provider: "passkey",
        nonce: "native-nonce",
        codeChallenge: nativeState.codeChallenge,
        codeChallengeMethod: "S256",
        scope: "openid profile",
      }),
    );
    const url = new URL(res.headers.get("Location")!);
    expect(url.searchParams.get("code")).toBe("auth-code-token");
    expect(url.searchParams.get("state")).toBe(mockStateData.bffState);
    expect(vi.mocked(resolveProvider)).not.toHaveBeenCalled();
    expect(vi.mocked(validateProviderCredentials)).not.toHaveBeenCalled();
  });
  it("rechecks account lockout before issuing any native auth code", async () => {
    vi.mocked(isAccountLocked).mockResolvedValue({
      locked: true,
      failedAttempts: 5,
      lockedUntil: "2026-11-07T22:00:00Z",
    });
    expect((await nativeRequest()).status).toBe(429);
    expect(vi.mocked(createAuthCode)).not.toHaveBeenCalled();
  });
  it("rejects an unregistered final redirect for native authentication", async () => {
    vi.mocked(validateServiceFinalRedirect).mockResolvedValue(false);
    expect((await nativeRequest()).status).toBe(400);
    expect(vi.mocked(createAuthCode)).not.toHaveBeenCalled();
  });
  it("does not issue a native code when a requested resource was deleted", async () => {
    vi.mocked(validateServiceFinalRedirect).mockResolvedValue(true);
    vi.mocked(findResourceServerByUri).mockResolvedValue(null);
    const res = await nativeRequest({ ...nativeState, resource: "https://resource.example.test" });
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("invalid_target");
    expect(vi.mocked(createAuthCode)).not.toHaveBeenCalled();
  });
  it("checks resource subject restrictions and pins its registration generation", async () => {
    vi.mocked(validateServiceFinalRedirect).mockResolvedValue(true);
    const resource = {
      id: "rs-native",
      uri: "https://resource.example.test",
      name: "Synthetic",
      allowed_scopes: "[]",
      owner_user_id: "admin",
      created_at: "2026-11-07",
      updated_at: "2026-11-07",
    };
    vi.mocked(findResourceServerByUri).mockResolvedValue({
      ...resource,
      allowed_subjects: '["other-user"]',
    });
    const denied = await nativeRequest({ ...nativeState, resource: resource.uri });
    expect(new URL(denied.headers.get("Location")!).searchParams.get("error")).toBe(
      "access_denied",
    );
    expect(vi.mocked(createAuthCode)).not.toHaveBeenCalled();
    vi.mocked(findResourceServerByUri).mockResolvedValue({
      ...resource,
      allowed_subjects: JSON.stringify([mockUser.id]),
    });
    expect((await nativeRequest({ ...nativeState, resource: resource.uri })).status).toBe(302);
    expect(vi.mocked(createAuthCode)).toHaveBeenCalledWith(
      mockEnv.DB,
      expect.objectContaining({
        provider: "passkey",
        resource: resource.uri,
        resourceServerId: "rs-native",
      }),
    );
  });
  it("preserves legacy absent method metadata rather than inventing an OAuth provider", async () => {
    vi.mocked(validateServiceFinalRedirect).mockResolvedValue(true);
    await nativeRequest({ ...nativeState, provider: undefined });
    expect(vi.mocked(createAuthCode)).toHaveBeenCalledWith(
      mockEnv.DB,
      expect.objectContaining({ provider: undefined }),
    );
  });
  it.each([
    ["passkey", 0],
    ["passkey", 1],
    ["google", 0],
    ["google", 1],
  ])(
    "requires verified email for bootstrap elevation (%s, verified=%i)",
    async (method, verified) => {
      const env = createMockIdpEnv({ BOOTSTRAP_ADMIN_EMAIL: "USER@example.com" });
      const user = { ...mockUser, email_verified: verified };
      vi.mocked(tryBootstrapAdmin).mockResolvedValue(true);
      vi.mocked(validateServiceFinalRedirect).mockResolvedValue(true);
      const app = new Hono<{
        Bindings: ReturnType<typeof createMockIdpEnv>;
        Variables: { user: TokenPayload };
      }>();
      app.get("/finish", (c) =>
        finalizeLogin(c, user, String(method), { ...nativeState, provider: String(method) }),
      );
      const res = await app.request("https://id.0g0.xyz/finish", {}, env);
      expect(res.status).toBe(302);
      expect(vi.mocked(createAuthCode)).toHaveBeenCalled();
      if (verified === 1) {
        expect(vi.mocked(tryBootstrapAdmin)).toHaveBeenCalledWith(env.DB, user.id);
        expect(user.role).toBe("admin");
      } else {
        expect(vi.mocked(tryBootstrapAdmin)).not.toHaveBeenCalled();
        expect(user.role).toBe("user");
      }
    },
  );
});
