import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { isAllowedRedirectTo } from "../utils/auth-helpers";
import { Hono } from "hono";
import { createMockIdpEnv } from "../../../../packages/shared/src/db/test-helpers";

// @0g0-id/sharedの全関数をモック
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const { parseJsonBody, restErrorBody, oauthErrorBody } =
    await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    parseJsonBody,
    restErrorBody,
    oauthErrorBody,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    PROVIDER_DISPLAY_NAMES: {
      google: "Google",
      line: "LINE",
      twitch: "Twitch",
      github: "GitHub",
      x: "X",
    },
    PROVIDER_CREDENTIALS: {
      line: { id: "LINE_CLIENT_ID", secret: "LINE_CLIENT_SECRET", name: "LINE" },
      twitch: { id: "TWITCH_CLIENT_ID", secret: "TWITCH_CLIENT_SECRET", name: "Twitch" },
      github: { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET", name: "GitHub" },
      x: { id: "X_CLIENT_ID", secret: "X_CLIENT_SECRET", name: "X" },
    },
    buildGoogleAuthUrl: vi.fn(),
    exchangeGoogleCode: vi.fn(),
    fetchGoogleUserInfo: vi.fn(),
    buildLineAuthUrl: vi.fn(),
    exchangeLineCode: vi.fn(),
    fetchLineUserInfo: vi.fn(),
    buildTwitchAuthUrl: vi.fn(),
    exchangeTwitchCode: vi.fn(),
    fetchTwitchUserInfo: vi.fn(),
    buildGithubAuthUrl: vi.fn(),
    exchangeGithubCode: vi.fn(),
    fetchGithubUserInfo: vi.fn(),
    fetchGithubPrimaryEmail: vi.fn(),
    buildXAuthUrl: vi.fn(),
    exchangeXCode: vi.fn(),
    fetchXUserInfo: vi.fn(),
    generateCodeVerifier: vi.fn(),
    generateCodeChallenge: vi.fn(),
    generateToken: vi.fn(),
    sha256: vi.fn(),
    generatePairwiseSub: vi.fn(),
    signAccessToken: vi.fn(),
    signIdToken: vi.fn(),
    createRefreshToken: vi.fn(),
    findRefreshTokenByHash: vi.fn(),
    findAndRevokeRefreshToken: vi.fn(),
    findUserById: vi.fn(),
    revokeRefreshToken: vi.fn(),
    unrevokeRefreshToken: vi.fn(),
    revokeTokenFamily: vi.fn(),
    upsertUser: vi.fn(),
    upsertLineUser: vi.fn(),
    upsertTwitchUser: vi.fn(),
    upsertGithubUser: vi.fn(),
    upsertXUser: vi.fn(),
    tryBootstrapAdmin: vi.fn(),
    createAuthCode: vi.fn(),
    findAndConsumeAuthCode: vi.fn(),
    findServiceById: vi.fn(),
    findServiceByClientId: vi.fn(),
    isValidRedirectUri: vi.fn(),
    timingSafeEqual: vi.fn(),
    linkProvider: vi.fn(),
    insertLoginEvent: vi.fn(),
    verifyAccessToken: vi.fn(),
    isAccessTokenRevoked: vi.fn().mockResolvedValue(false),
    ALL_PROVIDERS: ["google", "line", "twitch", "github", "x"],
    isValidProvider: (v: string) => ["google", "line", "twitch", "github", "x"].includes(v),
    normalizeRedirectUri: vi.fn((uri: string) => uri),
    listRedirectUris: vi.fn(),
    matchRedirectUri: vi.fn(),
    // HMAC-SHA256署名付きCookie（state cookie改ざん検知用）
    signCookie: vi
      .fn()
      .mockImplementation(async (payload: string) => btoa(encodeURIComponent(payload))),
    verifyCookie: vi.fn().mockImplementation(async (value: string) => {
      try {
        return decodeURIComponent(atob(decodeURIComponent(value)));
      } catch {
        return null;
      }
    }),
    // token-recovery.ts 経由で使用
    findRefreshTokenById: vi.fn(),
    // JTIブロックリスト
    addRevokedAccessToken: vi.fn(),
  };
});

import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  buildLineAuthUrl,
  exchangeLineCode,
  fetchLineUserInfo,
  upsertLineUser,
  buildGithubAuthUrl,
  exchangeGithubCode,
  fetchGithubUserInfo,
  fetchGithubPrimaryEmail,
  upsertGithubUser,
  exchangeXCode,
  fetchXUserInfo,
  upsertXUser,
  exchangeTwitchCode,
  fetchTwitchUserInfo,
  upsertTwitchUser,
  linkProvider,
  tryBootstrapAdmin,
  generateCodeVerifier,
  generateCodeChallenge,
  generateToken,
  sha256,
  generatePairwiseSub,
  signAccessToken,
  signIdToken,
  createRefreshToken,
  findRefreshTokenByHash,
  findAndRevokeRefreshToken,
  findUserById,
  revokeRefreshToken,
  unrevokeRefreshToken,
  revokeTokenFamily,
  upsertUser,
  createAuthCode,
  findAndConsumeAuthCode,
  findServiceById,
  findServiceByClientId,
  timingSafeEqual,
  verifyAccessToken,
  listRedirectUris,
  matchRedirectUri,
  normalizeRedirectUri,
  signCookie,
  verifyCookie,
  findRefreshTokenById,
  addRevokedAccessToken,
} from "@0g0-id/shared";

import authRoutes from "./auth";

const baseUrl = "https://id.0g0.xyz";

const mockEnv = createMockIdpEnv({
  LINE_CLIENT_ID: "line-client-id",
  LINE_CLIENT_SECRET: "line-client-secret",
  TWITCH_CLIENT_ID: "twitch-client-id",
  TWITCH_CLIENT_SECRET: "twitch-client-secret",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  X_CLIENT_ID: "x-client-id",
  X_CLIENT_SECRET: "x-client-secret",
  INTERNAL_SERVICE_SECRET: "mock-internal-secret",
});

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

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route("/auth", authRoutes);
  return app;
}

async function sendRequest(
  app: ReturnType<typeof buildApp>,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const { method = "GET", body, headers = {} } = options;
  const reqHeaders: Record<string, string> = { ...headers };
  if (body) reqHeaders["Content-Type"] = "application/json";
  // serviceBindingMiddleware で保護されたパスには内部シークレットを自動付与
  // timingSafeEqual モックをミドルウェア通過のため一時的に true に設定
  if (
    path.startsWith("/auth/exchange") ||
    path.startsWith("/auth/refresh") ||
    path.startsWith("/auth/logout")
  ) {
    reqHeaders["X-Internal-Secret"] ??= "mock-internal-secret";
    vi.mocked(timingSafeEqual).mockReturnValueOnce(true);
  }

  return app.request(
    new Request(`${baseUrl}${path}`, {
      method,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : undefined,
    }),
    undefined,
    mockEnv,
  );
}

// Cookieつきのstate/PKCEセットアップ用ヘルパー
function buildStateCookie(data: {
  idState: string;
  bffState: string;
  redirectTo: string;
  provider: string;
  linkUserId?: string;
}): string {
  return btoa(encodeURIComponent(JSON.stringify(data)));
}

// ===== GET /auth/login =====
describe("GET /auth/login", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateToken).mockReturnValue("mock-token-16");
    vi.mocked(generateCodeVerifier).mockReturnValue("mock-code-verifier");
    vi.mocked(generateCodeChallenge).mockResolvedValue("mock-code-challenge");
    vi.mocked(buildGoogleAuthUrl).mockReturnValue("https://accounts.google.com/o/oauth2/auth?...");
    vi.mocked(buildLineAuthUrl).mockReturnValue("https://access.line.me/oauth2/v2.1/authorize?...");
    vi.mocked(buildGithubAuthUrl).mockReturnValue("https://github.com/login/oauth/authorize?...");
    vi.mocked(signCookie).mockImplementation(async (payload: string) =>
      btoa(encodeURIComponent(payload)),
    );
    vi.mocked(verifyCookie).mockImplementation(async (value: string) => {
      try {
        return decodeURIComponent(atob(decodeURIComponent(value)));
      } catch {
        return null;
      }
    });
  });

  it("redirect_toが未指定 → 400を返す", async () => {
    const res = await sendRequest(app, "/auth/login?state=bff-state");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("stateが未指定 → 400を返す", async () => {
    const res = await sendRequest(app, "/auth/login?redirect_to=https://user.0g0.xyz/callback");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("redirect_toが長すぎる → 400を返す", async () => {
    const longUrl = "https://user.0g0.xyz/callback" + "a".repeat(2100);
    const res = await sendRequest(
      app,
      `/auth/login?redirect_to=${encodeURIComponent(longUrl)}&state=bff-state`,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("不正なprovider → 400を返す", async () => {
    const res = await sendRequest(
      app,
      "/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=unknown",
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("不正なredirect_to（許可外オリジン）→ 400を返す", async () => {
    const res = await sendRequest(
      app,
      "/auth/login?redirect_to=https://evil.com/callback&state=bff-state",
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("Google: 正常なリクエスト → Googleへリダイレクト", async () => {
    const res = await sendRequest(
      app,
      "/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=google",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("accounts.google.com");
  });

  it("LINE: 正常なリクエスト → LINEへリダイレクト", async () => {
    const res = await sendRequest(
      app,
      "/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=line",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("access.line.me");
  });

  it("GitHub: 正常なリクエスト → GitHubへリダイレクト", async () => {
    const res = await sendRequest(
      app,
      "/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=github",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("github.com");
  });

  it("LINE: クレデンシャル未設定 → 400を返す", async () => {
    const envWithoutLine = { ...mockEnv, LINE_CLIENT_ID: "", LINE_CLIENT_SECRET: "" };
    const res = await buildApp().request(
      new Request(
        `${baseUrl}/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=line`,
      ),
      undefined,
      envWithoutLine,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("PROVIDER_NOT_CONFIGURED");
  });

  it("adminオリジンのredirect_toも許可", async () => {
    const res = await sendRequest(
      app,
      "/auth/login?redirect_to=https://admin.0g0.xyz/callback&state=bff-state&provider=google",
    );
    expect(res.status).toBe(302);
  });

  it("有効なlink_token → linkUserIdをstate cookieに設定してリダイレクト", async () => {
    // verifyCookieモックはdecodeURIComponent(atob(decodeURIComponent(value)))を返す
    // signCookieモックはbtoa(encodeURIComponent(payload))を返すため、その形式でトークンを作成
    const validPayload = JSON.stringify({
      purpose: "link",
      sub: "existing-user-id",
      exp: Date.now() + 60000,
    });
    const validToken = btoa(encodeURIComponent(validPayload));
    const res = await sendRequest(
      app,
      `/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=google&link_token=${encodeURIComponent(validToken)}`,
    );
    expect(res.status).toBe(302);
    // state cookieにlinkUserIdが含まれることを確認
    const cookies = res.headers.get("set-cookie") ?? "";
    const stateCookieMatch = cookies.match(/__Host-oauth-state=([^;]+)/);
    if (stateCookieMatch) {
      const decoded = JSON.parse(decodeURIComponent(atob(decodeURIComponent(stateCookieMatch[1]))));
      expect(decoded.linkUserId).toBe("existing-user-id");
    }
  });

  it("無効なlink_token（HMAC署名検証失敗）→ 400を返す", async () => {
    // verifyCookieモックはatob失敗時にnullを返す
    const res = await sendRequest(
      app,
      "/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=google&link_token=invalid-token",
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_LINK_TOKEN");
  });

  it("期限切れlink_token → 400を返す", async () => {
    // 期限切れペイロードをverifyCookieが返す場合
    const expiredPayload = JSON.stringify({
      purpose: "link",
      sub: "user-1",
      exp: Date.now() - 1000,
    });
    const expiredToken = btoa(encodeURIComponent(expiredPayload));
    const res = await sendRequest(
      app,
      `/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=google&link_token=${encodeURIComponent(expiredToken)}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_LINK_TOKEN");
  });

  it("purposeフィールドがないlink_token → 400を返す", async () => {
    // purpose未設定のペイロード（旧形式）
    const noPurposePayload = JSON.stringify({ sub: "user-1", exp: Date.now() + 60000 });
    const noPurposeToken = btoa(encodeURIComponent(noPurposePayload));
    const res = await sendRequest(
      app,
      `/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=google&link_token=${encodeURIComponent(noPurposeToken)}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_LINK_TOKEN");
  });

  it("link_user_idパラメータは無視される（旧APIの廃止確認）", async () => {
    // link_user_idを直接渡しても連携フローにはならない
    const res = await sendRequest(
      app,
      "/auth/login?redirect_to=https://user.0g0.xyz/callback&state=bff-state&provider=google&link_user_id=victim-user-id",
    );
    expect(res.status).toBe(302);
    // state cookieにlinkUserIdが含まれないことを確認
    const cookies = res.headers.get("set-cookie") ?? "";
    const stateCookieMatch = cookies.match(/__Host-oauth-state=([^;]+)/);
    if (stateCookieMatch) {
      const decoded = JSON.parse(decodeURIComponent(atob(decodeURIComponent(stateCookieMatch[1]))));
      expect(decoded.linkUserId).toBeUndefined();
    }
  });
});

// ===== GET /auth/callback =====
describe("GET /auth/callback", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue("hashed-value");
    vi.mocked(generateToken).mockReturnValue("mock-auth-code");
    vi.mocked(upsertUser).mockResolvedValue(mockUser);
    vi.mocked(tryBootstrapAdmin).mockResolvedValue(false);
    vi.mocked(createAuthCode).mockResolvedValue(undefined as never);
    vi.mocked(exchangeGoogleCode).mockResolvedValue({ access_token: "google-at" } as never);
    vi.mocked(fetchGoogleUserInfo).mockResolvedValue({
      sub: "google-sub-1",
      email: "test@example.com",
      email_verified: true,
      name: "Test User",
      picture: "https://example.com/pic.jpg",
    } as never);
    // state比較はtimingSafeEqualを使用するためデフォルトでtrueを返す
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(signCookie).mockImplementation(async (payload: string) =>
      btoa(encodeURIComponent(payload)),
    );
    vi.mocked(verifyCookie).mockImplementation(async (value: string) => {
      try {
        return decodeURIComponent(atob(decodeURIComponent(value)));
      } catch {
        return null;
      }
    });
  });

  it("errorパラメータあり + Cookieなし → 400フォールバック", async () => {
    const res = await sendRequest(app, "/auth/callback?error=access_denied");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("OAUTH_ERROR");
  });

  it("errorパラメータあり + 有効Cookie → BFFへリダイレクト（RFC 6749 §4.1.2.1）", async () => {
    const stateData = buildStateCookie({
      idState: "id-state",
      bffState: "bff-state-abc",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "google",
    });
    const res = await sendRequest(app, "/auth/callback?error=access_denied", {
      headers: { Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier` },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    const redirectUrl = new URL(location);
    expect(redirectUrl.searchParams.get("error")).toBe("access_denied");
    expect(redirectUrl.searchParams.get("state")).toBe("bff-state-abc");
    expect(redirectUrl.pathname).toBe("/callback");
  });

  it("errorパラメータが未知の値 → access_deniedにサニタイズしてリダイレクト", async () => {
    const stateData = buildStateCookie({
      idState: "id-state",
      bffState: "bff-state-xyz",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "google",
    });
    const res = await sendRequest(app, "/auth/callback?error=unknown_internal_error", {
      headers: { Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier` },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    const redirectUrl = new URL(location);
    expect(redirectUrl.searchParams.get("error")).toBe("access_denied");
    expect(redirectUrl.searchParams.get("state")).toBe("bff-state-xyz");
  });

  it("codeまたはstateが未指定 → 400を返す", async () => {
    const res = await sendRequest(app, "/auth/callback?code=abc");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("Cookieなし → 400を返す", async () => {
    const res = await sendRequest(app, "/auth/callback?code=abc&state=some-state");
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("state不一致 → 400を返す", async () => {
    // state不一致の場合はtimingSafeEqualがfalseを返す
    vi.mocked(timingSafeEqual).mockReturnValue(false);
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "google",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=wrong-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("Googleコールバック正常 → BFFコールバックへリダイレクト", async () => {
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "google",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://user.0g0.xyz/callback");
    expect(location).toContain("state=bff-state");
  });

  it("Googleコールバック: メール未確認 → 400を返す", async () => {
    vi.mocked(fetchGoogleUserInfo).mockResolvedValue({
      sub: "google-sub-1",
      email: "test@example.com",
      email_verified: false,
      name: "Test User",
      picture: null,
    } as never);
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "google",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNVERIFIED_EMAIL");
  });

  it("不正なstate cookie → 400を返す", async () => {
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=some-state`, {
        headers: {
          Cookie: `__Host-oauth-state=!!!invalid-base64!!!; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});

// ===== POST /auth/exchange =====
describe("POST /auth/exchange", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    // serviceBindingMiddleware 通過用（X-Internal-Secret ヘッダー検証）
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(sha256).mockResolvedValue("hashed-code");
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
      id: "code-id",
      user_id: "user-1",
      service_id: null,
      code_hash: "hashed-code",
      redirect_to: "https://user.0g0.xyz/callback",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      used_at: null,
      created_at: "2024-01-01T00:00:00Z",
    } as never);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(signAccessToken).mockResolvedValue("mock-access-token");
    vi.mocked(signIdToken).mockResolvedValue("mock-id-token");
    vi.mocked(createRefreshToken).mockResolvedValue(undefined as never);
  });

  it("JSONボディが不正 → 400を返す", async () => {
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": "mock-internal-secret",
        },
        body: "not-json",
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("codeまたはredirect_toが未指定 → 400を返す", async () => {
    const res = await sendRequest(app, "/auth/exchange", {
      method: "POST",
      body: { code: "some-code" },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("無効なコード → 400を返す", async () => {
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue(null);
    const res = await sendRequest(app, "/auth/exchange", {
      method: "POST",
      body: { code: "invalid-code", redirect_to: "https://user.0g0.xyz/callback" },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_CODE");
  });

  it("redirect_to不一致 → 400を返す", async () => {
    const res = await sendRequest(app, "/auth/exchange", {
      method: "POST",
      body: { code: "valid-code", redirect_to: "https://admin.0g0.xyz/callback" },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_CODE");
  });

  it("ユーザー不存在 → 404を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, "/auth/exchange", {
      method: "POST",
      body: { code: "valid-code", redirect_to: "https://user.0g0.xyz/callback" },
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("正常なコード交換 → アクセストークン・IDトークン・リフレッシュトークンを返す", async () => {
    const res = await sendRequest(app, "/auth/exchange", {
      method: "POST",
      body: { code: "valid-code", redirect_to: "https://user.0g0.xyz/callback" },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: {
        access_token: string;
        id_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
        user: { id: string; email: string };
      };
    }>();
    expect(body.data.access_token).toBe("mock-access-token");
    expect(body.data.id_token).toBe("mock-id-token");
    expect(body.data.token_type).toBe("Bearer");
    expect(body.data.expires_in).toBe(900);
    expect(body.data.user.id).toBe("user-1");
    expect(body.data.user.email).toBe("test@example.com");
    // signIdToken が正しいペイロードで呼ばれていることを確認
    expect(vi.mocked(signIdToken)).toHaveBeenCalledWith(
      expect.objectContaining({
        iss: "https://id.0g0.xyz",
        sub: "user-1",
        aud: "https://id.0g0.xyz",
        email: "test@example.com",
        name: "Test User",
      }),
      "mock-private-key",
      "mock-public-key",
    );
  });
});

// ===== POST /auth/refresh =====
describe("POST /auth/refresh", () => {
  const app = buildApp();

  const mockRefreshToken = {
    id: "rt-id",
    user_id: "user-1",
    service_id: null,
    token_hash: "hashed-token",
    family_id: "family-1",
    revoked_at: null,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: "2024-01-01T00:00:00Z",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    // serviceBindingMiddleware 通過用
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(sha256).mockResolvedValue("hashed-token");
    vi.mocked(generateToken).mockReturnValue("new-refresh-token-raw");
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(mockRefreshToken as never);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(signAccessToken).mockResolvedValue("new-access-token");
    vi.mocked(createRefreshToken).mockResolvedValue(undefined as never);
    vi.mocked(findRefreshTokenById).mockResolvedValue(mockRefreshToken as never);
  });

  it("JSONボディが不正 → 400を返す", async () => {
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": "mock-internal-secret",
        },
        body: "not-json",
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("refresh_tokenが未指定 → 400を返す", async () => {
    const res = await sendRequest(app, "/auth/refresh", {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("トークンが存在しない → 401を返す", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    const res = await sendRequest(app, "/auth/refresh", {
      method: "POST",
      body: { refresh_token: "invalid-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_TOKEN");
  });

  it("失効済みトークン（rotation後の再利用＝リプレイ攻撃）→ family全失効 + 401を返す", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: "2024-01-01T00:00:00Z",
      revoked_reason: "rotation",
    } as never);
    vi.mocked(revokeTokenFamily).mockResolvedValue(undefined as never);

    const res = await sendRequest(app, "/auth/refresh", {
      method: "POST",
      body: { refresh_token: "revoked-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("TOKEN_REUSE");
    expect(vi.mocked(revokeTokenFamily)).toHaveBeenCalledWith(
      mockEnv.DB,
      "family-1",
      "reuse_detected",
    );
  });

  it("グレースピリオド内（30秒以内）のrotation再利用 → TOKEN_ROTATED + family失効なし", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: new Date(Date.now() - 10_000).toISOString(), // 10秒前（グレースピリオド内）
      revoked_reason: "rotation",
    } as never);

    const res = await sendRequest(app, "/auth/refresh", {
      method: "POST",
      body: { refresh_token: "recently-rotated-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("TOKEN_ROTATED");
    // グレースピリオド内はfamilyを失効させない
    expect(vi.mocked(revokeTokenFamily)).not.toHaveBeenCalled();
  });

  it("rotation + revoked_atがnull → 0時点とみなしグレースピリオド超過 → family全失効", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: null,
      revoked_reason: "rotation",
    } as never);
    vi.mocked(revokeTokenFamily).mockResolvedValue(undefined as never);

    const res = await sendRequest(app, "/auth/refresh", {
      method: "POST",
      body: { refresh_token: "null-revokedat-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("TOKEN_REUSE");
    expect(vi.mocked(revokeTokenFamily)).toHaveBeenCalledWith(
      mockEnv.DB,
      "family-1",
      "reuse_detected",
    );
  });

  it("user_logoutで失効済みトークン → family全失効せずINVALID_TOKENを返す", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue(null);
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: "2024-01-01T00:00:00Z",
      revoked_reason: "user_logout",
    } as never);

    const res = await sendRequest(app, "/auth/refresh", {
      method: "POST",
      body: { refresh_token: "logged-out-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_TOKEN");
    expect(vi.mocked(revokeTokenFamily)).not.toHaveBeenCalled();
  });

  it("期限切れトークン → 401を返す", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue({
      ...mockRefreshToken,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    } as never);

    const res = await sendRequest(app, "/auth/refresh", {
      method: "POST",
      body: { refresh_token: "expired-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("TOKEN_EXPIRED");
  });

  it("ユーザー不存在 → 401を返す", async () => {
    // findAndRevokeRefreshToken はデフォルトで mockRefreshToken を返す（beforeEach設定済み）
    vi.mocked(findUserById).mockResolvedValue(null);
    const res = await sendRequest(app, "/auth/refresh", {
      method: "POST",
      body: { refresh_token: "valid-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_GRANT");
  });

  it("正常なリフレッシュ → 新しいトークンペアを返す", async () => {
    const res = await sendRequest(app, "/auth/refresh", {
      method: "POST",
      body: { refresh_token: "valid-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: { access_token: string; refresh_token: string; token_type: string; expires_in: number };
    }>();
    expect(body.data.access_token).toBe("new-access-token");
    expect(body.data.token_type).toBe("Bearer");
    expect(body.data.expires_in).toBe(900);
    expect(body.data.refresh_token).toBeTruthy();
    // findAndRevokeRefreshToken が atomically 失効させるため revokeRefreshToken は呼ばれない
    expect(vi.mocked(revokeRefreshToken)).not.toHaveBeenCalled();
    // 新トークンを同じfamily_idで発行することを確認
    expect(vi.mocked(createRefreshToken)).toHaveBeenCalledWith(
      mockEnv.DB,
      expect.objectContaining({ familyId: "family-1" }),
    );
  });

  it("削除済みサービスのトークン → 401を返す", async () => {
    vi.mocked(findAndRevokeRefreshToken).mockResolvedValue({
      ...mockRefreshToken,
      service_id: "deleted-service-id",
    } as never);
    vi.mocked(findServiceById).mockResolvedValue(null);

    const res = await sendRequest(app, "/auth/refresh", {
      method: "POST",
      body: { refresh_token: "valid-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_TOKEN");
  });

  it("issueTokenPair失敗 + reuse_detected競合 → TOKEN_REUSE + unrevoke不実施", async () => {
    // issueTokenPair内でsignAccessTokenを失敗させる
    vi.mocked(signAccessToken).mockRejectedValue(new Error("key not available"));
    // 並行リクエストがreuse_detectedを設定した状態をシミュレート
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: new Date().toISOString(),
      revoked_reason: "reuse_detected",
    } as never);

    const res = await sendRequest(app, "/auth/refresh", {
      method: "POST",
      body: { refresh_token: "valid-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("TOKEN_REUSE");
    // reuse_detected時はunrevokeしてはいけない
    expect(vi.mocked(unrevokeRefreshToken)).not.toHaveBeenCalled();
  });

  it("issueTokenPair失敗（通常のエラー）→ INTERNAL_ERROR + unrevoke実施", async () => {
    // issueTokenPair内でsignAccessTokenを失敗させる
    vi.mocked(signAccessToken).mockRejectedValue(new Error("key not available"));
    // reuse_detectedではない状態（通常のDB障害シナリオ）
    vi.mocked(findRefreshTokenByHash).mockResolvedValue({
      ...mockRefreshToken,
      revoked_at: new Date().toISOString(),
      revoked_reason: "rotation",
    } as never);
    vi.mocked(unrevokeRefreshToken).mockResolvedValue(true);

    const res = await sendRequest(app, "/auth/refresh", {
      method: "POST",
      body: { refresh_token: "valid-token" },
    });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    // 通常エラーの場合はunrevokeを試みる
    expect(vi.mocked(unrevokeRefreshToken)).toHaveBeenCalled();
  });
});

// ===== POST /auth/logout =====
describe("POST /auth/logout", () => {
  const app = buildApp();

  const mockRefreshToken = {
    id: "rt-id",
    user_id: "user-1",
    service_id: null,
    token_hash: "hashed-token",
    family_id: "family-1",
    revoked_at: null,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: "2024-01-01T00:00:00Z",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    // serviceBindingMiddleware 通過用
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(sha256).mockResolvedValue("hashed-token");
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(mockRefreshToken as never);
    vi.mocked(revokeRefreshToken).mockResolvedValue(undefined as never);
  });

  it("JSONボディが不正 → 400を返す", async () => {
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/logout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": "mock-internal-secret",
        },
        body: "not-json",
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("refresh_tokenなし → successを返す（冪等）", async () => {
    const res = await sendRequest(app, "/auth/logout", {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { success: boolean } }>();
    expect(body.data.success).toBe(true);
    expect(vi.mocked(revokeRefreshToken)).not.toHaveBeenCalled();
  });

  it("有効なrefresh_token → 単一トークン失効 + successを返す", async () => {
    const res = await sendRequest(app, "/auth/logout", {
      method: "POST",
      body: { refresh_token: "valid-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { success: boolean } }>();
    expect(body.data.success).toBe(true);
    expect(vi.mocked(revokeRefreshToken)).toHaveBeenCalledWith(mockEnv.DB, "rt-id", "user_logout");
  });

  it("存在しないrefresh_token → エラーなくsuccessを返す", async () => {
    vi.mocked(findRefreshTokenByHash).mockResolvedValue(null);
    const res = await sendRequest(app, "/auth/logout", {
      method: "POST",
      body: { refresh_token: "unknown-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { success: boolean } }>();
    expect(body.data.success).toBe(true);
  });

  it("有効なアクセストークンをAuthorizationヘッダーに含む → addRevokedAccessTokenがJTIで呼ばれる", async () => {
    const mockJti = "jti-access-123";
    const mockExp = Math.floor(Date.now() / 1000) + 900;
    vi.mocked(verifyAccessToken).mockResolvedValue({
      sub: "user-1",
      email: "test@example.com",
      role: "user",
      iss: "https://id.0g0.xyz",
      aud: "https://id.0g0.xyz",
      exp: mockExp,
      iat: Math.floor(Date.now() / 1000),
      jti: mockJti,
      kid: "kid-1",
    } as never);
    vi.mocked(addRevokedAccessToken).mockResolvedValue(undefined as never);

    const res = await sendRequest(app, "/auth/logout", {
      method: "POST",
      body: {},
      headers: { Authorization: "Bearer valid-access-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { success: boolean } }>();
    expect(body.data.success).toBe(true);
    expect(vi.mocked(addRevokedAccessToken)).toHaveBeenCalledWith(mockEnv.DB, mockJti, mockExp);
  });

  it("無効/期限切れのアクセストークンをAuthorizationヘッダーに含む → verifyAccessToken失敗でも成功を返す・addRevokedAccessToken未呼び出し", async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error("JWT verification failed"));
    vi.mocked(addRevokedAccessToken).mockResolvedValue(undefined as never);

    const res = await sendRequest(app, "/auth/logout", {
      method: "POST",
      body: {},
      headers: { Authorization: "Bearer invalid-or-expired-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { success: boolean } }>();
    expect(body.data.success).toBe(true);
    expect(vi.mocked(addRevokedAccessToken)).not.toHaveBeenCalled();
  });

  it("Authorizationヘッダーなし → 成功を返す・addRevokedAccessToken未呼び出し", async () => {
    vi.mocked(addRevokedAccessToken).mockResolvedValue(undefined as never);

    const res = await sendRequest(app, "/auth/logout", {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { success: boolean } }>();
    expect(body.data.success).toBe(true);
    expect(vi.mocked(addRevokedAccessToken)).not.toHaveBeenCalled();
  });

  it("INTERNAL_SERVICE_SECRET設定時にヘッダーなし → 403を返す", async () => {
    const envWithSecret = { ...mockEnv, INTERNAL_SERVICE_SECRET: "test-secret" };
    const securedApp = new Hono<{ Bindings: typeof mockEnv }>();
    securedApp.route("/auth", authRoutes);
    const res = await securedApp.request(
      new Request(`${baseUrl}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: "some-token" }),
      }),
      undefined,
      envWithSecret,
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });
});

// ===== POST /auth/link-intent =====
describe("POST /auth/link-intent", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findUserById).mockResolvedValue({ id: "user-1", banned_at: null } as never);
    vi.mocked(signCookie).mockImplementation(async (payload: string) =>
      btoa(encodeURIComponent(payload)),
    );
    vi.mocked(verifyAccessToken).mockResolvedValue({
      sub: "user-1",
      email: "test@example.com",
      role: "user",
      iss: "https://id.0g0.xyz",
      aud: "https://id.0g0.xyz",
      exp: Math.floor(Date.now() / 1000) + 900,
      iat: Math.floor(Date.now() / 1000),
      jti: "jti-1",
      kid: "kid-1",
    } as never);
  });

  it("認証なし → 401を返す", async () => {
    const res = await sendRequest(app, "/auth/link-intent", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("有効なBearerトークン → HMAC署名済みlink_tokenを返す", async () => {
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/link-intent`, {
        method: "POST",
        headers: { Authorization: "Bearer valid-access-token" },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { link_token: string } }>();
    // signCookieが呼ばれ、sub: 'user-1'を含むペイロードで署名されることを確認
    expect(vi.mocked(signCookie)).toHaveBeenCalledWith(
      expect.stringContaining('"purpose":"link"'),
      mockEnv.COOKIE_SECRET,
    );
    // 返されたlink_tokenはsignCookieの戻り値（DBへの保存は不要）
    expect(body.data.link_token).toBeTruthy();
    expect(vi.mocked(createAuthCode)).not.toHaveBeenCalled();
  });
});

// ===== GET /auth/callback - LINEプロバイダー =====
describe("GET /auth/callback - LINEプロバイダー", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue("hashed-value");
    vi.mocked(generateToken).mockReturnValue("mock-auth-code");
    vi.mocked(upsertLineUser).mockResolvedValue(mockUser);
    vi.mocked(tryBootstrapAdmin).mockResolvedValue(false);
    vi.mocked(createAuthCode).mockResolvedValue(undefined as never);
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(exchangeLineCode).mockResolvedValue({ access_token: "line-at" } as never);
    vi.mocked(fetchLineUserInfo).mockResolvedValue({
      sub: "line-sub-1",
      name: "LINE User",
      picture: "https://example.com/line-pic.jpg",
      email: "line@example.com",
    } as never);
    vi.mocked(signCookie).mockImplementation(async (payload: string) =>
      btoa(encodeURIComponent(payload)),
    );
    vi.mocked(verifyCookie).mockImplementation(async (value: string) => {
      try {
        return decodeURIComponent(atob(decodeURIComponent(value)));
      } catch {
        return null;
      }
    });
  });

  it("LINE: 正常なコールバック → BFFコールバックへリダイレクト", async () => {
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "line",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://user.0g0.xyz/callback");
    expect(location).toContain("state=bff-state");
  });

  it("LINE: tokenExchange失敗 → 400を返す", async () => {
    vi.mocked(exchangeLineCode).mockRejectedValue(new Error("Exchange failed"));
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "line",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("OAUTH_ERROR");
  });

  it("LINE: メールなし → 仮メールでupsertLineUserを呼び出す", async () => {
    vi.mocked(fetchLineUserInfo).mockResolvedValue({
      sub: "line-sub-1",
      name: "LINE User",
      picture: null,
      email: null,
    } as never);
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "line",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(302);
    expect(vi.mocked(upsertLineUser)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        isPlaceholderEmail: true,
        email: "line_line-sub-1@line.placeholder",
      }),
    );
  });
});

// ===== GET /auth/callback - GitHubプロバイダー =====
describe("GET /auth/callback - GitHubプロバイダー", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue("hashed-value");
    vi.mocked(generateToken).mockReturnValue("mock-auth-code");
    vi.mocked(upsertGithubUser).mockResolvedValue(mockUser);
    vi.mocked(tryBootstrapAdmin).mockResolvedValue(false);
    vi.mocked(createAuthCode).mockResolvedValue(undefined as never);
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(exchangeGithubCode).mockResolvedValue({ access_token: "github-at" } as never);
    vi.mocked(fetchGithubUserInfo).mockResolvedValue({
      id: 12345,
      login: "testuser",
      name: "GitHub User",
      email: "github@example.com",
      avatar_url: "https://example.com/avatar.jpg",
    } as never);
    // 常にEmails APIから検証済みメールを取得する（User APIのemailは未検証の可能性があるため）
    vi.mocked(fetchGithubPrimaryEmail).mockResolvedValue("github@example.com");
    vi.mocked(signCookie).mockImplementation(async (payload: string) =>
      btoa(encodeURIComponent(payload)),
    );
    vi.mocked(verifyCookie).mockImplementation(async (value: string) => {
      try {
        return decodeURIComponent(atob(decodeURIComponent(value)));
      } catch {
        return null;
      }
    });
  });

  it("GitHub: 正常なコールバック → fetchGithubPrimaryEmailで検証済みメールを取得", async () => {
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "github",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(302);
    expect(vi.mocked(fetchGithubPrimaryEmail)).toHaveBeenCalledWith("github-at");
    expect(vi.mocked(upsertGithubUser)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        githubSub: "12345",
        email: "github@example.com",
        isPlaceholderEmail: false,
      }),
    );
  });

  it("GitHub: Emails APIからプライマリメールを取得する", async () => {
    vi.mocked(fetchGithubUserInfo).mockResolvedValue({
      id: 12345,
      login: "testuser",
      name: null,
      email: null,
      avatar_url: "https://example.com/avatar.jpg",
    } as never);
    vi.mocked(fetchGithubPrimaryEmail).mockResolvedValue("primary@example.com");
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "github",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(302);
    expect(vi.mocked(fetchGithubPrimaryEmail)).toHaveBeenCalledWith("github-at");
    expect(vi.mocked(upsertGithubUser)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email: "primary@example.com",
        isPlaceholderEmail: false,
        name: "testuser",
      }),
    );
  });

  it("GitHub: プライマリメールも取得できない → 仮メールで登録される", async () => {
    vi.mocked(fetchGithubUserInfo).mockResolvedValue({
      id: 12345,
      login: "testuser",
      name: "GitHub User",
      email: null,
      avatar_url: "https://example.com/avatar.jpg",
    } as never);
    vi.mocked(fetchGithubPrimaryEmail).mockResolvedValue(null);
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "github",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(302);
    expect(vi.mocked(upsertGithubUser)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email: "github_12345@github.placeholder",
        isPlaceholderEmail: true,
      }),
    );
  });
});

// ===== GET /auth/callback - Twitchプロバイダー =====
describe("GET /auth/callback - Twitchプロバイダー", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue("hashed-value");
    vi.mocked(generateToken).mockReturnValue("mock-auth-code");
    vi.mocked(upsertTwitchUser).mockResolvedValue(mockUser);
    vi.mocked(tryBootstrapAdmin).mockResolvedValue(false);
    vi.mocked(createAuthCode).mockResolvedValue(undefined as never);
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(exchangeTwitchCode).mockResolvedValue({ access_token: "twitch-at" } as never);
    vi.mocked(fetchTwitchUserInfo).mockResolvedValue({
      sub: "twitch-sub-1",
      preferred_username: "twitchuser",
      email: "twitch@example.com",
      email_verified: true,
      picture: "https://example.com/twitch-pic.jpg",
    } as never);
    vi.mocked(signCookie).mockImplementation(async (payload: string) =>
      btoa(encodeURIComponent(payload)),
    );
    vi.mocked(verifyCookie).mockImplementation(async (value: string) => {
      try {
        return decodeURIComponent(atob(decodeURIComponent(value)));
      } catch {
        return null;
      }
    });
  });

  it("Twitch: 正常なコールバック → BFFコールバックへリダイレクト", async () => {
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "twitch",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(302);
    expect(vi.mocked(upsertTwitchUser)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        twitchSub: "twitch-sub-1",
        name: "twitchuser",
        isPlaceholderEmail: false,
      }),
    );
  });

  it("Twitch: メールなし → 仮メールで登録される", async () => {
    vi.mocked(fetchTwitchUserInfo).mockResolvedValue({
      sub: "twitch-sub-1",
      preferred_username: "twitchuser",
      email: null,
      email_verified: false,
      picture: null,
    } as never);
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "twitch",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(302);
    expect(vi.mocked(upsertTwitchUser)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        isPlaceholderEmail: true,
        email: "twitch_twitch-sub-1@twitch.placeholder",
      }),
    );
  });

  it("Twitch: メール未確認 → 400を返す", async () => {
    vi.mocked(fetchTwitchUserInfo).mockResolvedValue({
      sub: "twitch-sub-1",
      preferred_username: "twitchuser",
      email: "twitch@example.com",
      email_verified: false,
      picture: null,
    } as never);
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "twitch",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNVERIFIED_EMAIL");
  });
});

// ===== GET /auth/callback - Xプロバイダー =====
describe("GET /auth/callback - Xプロバイダー", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue("hashed-value");
    vi.mocked(generateToken).mockReturnValue("mock-auth-code");
    vi.mocked(upsertXUser).mockResolvedValue(mockUser);
    vi.mocked(tryBootstrapAdmin).mockResolvedValue(false);
    vi.mocked(createAuthCode).mockResolvedValue(undefined as never);
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(exchangeXCode).mockResolvedValue({ access_token: "x-at" } as never);
    vi.mocked(fetchXUserInfo).mockResolvedValue({
      id: "x-user-id",
      name: "X User",
      username: "xuser",
      profile_image_url: "https://example.com/x-pic.jpg",
    } as never);
    vi.mocked(signCookie).mockImplementation(async (payload: string) =>
      btoa(encodeURIComponent(payload)),
    );
    vi.mocked(verifyCookie).mockImplementation(async (value: string) => {
      try {
        return decodeURIComponent(atob(decodeURIComponent(value)));
      } catch {
        return null;
      }
    });
  });

  it("X: 正常なコールバック → 仮メールで登録・BFFコールバックへリダイレクト", async () => {
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "x",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(302);
    expect(vi.mocked(upsertXUser)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        xSub: "x-user-id",
        email: "x_x-user-id@x.placeholder",
        name: "X User",
      }),
    );
  });

  it("X: nameがnullの場合 → usernameをfallbackとして使用", async () => {
    vi.mocked(fetchXUserInfo).mockResolvedValue({
      id: "x-user-id",
      name: null,
      username: "xuser",
      profile_image_url: null,
    } as never);
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "x",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(302);
    expect(vi.mocked(upsertXUser)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "xuser" }),
    );
  });
});

// ===== GET /auth/callback - プロバイダー連携 (linkUserId) =====
describe("GET /auth/callback - プロバイダー連携 (linkUserId)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue("hashed-value");
    vi.mocked(generateToken).mockReturnValue("mock-auth-code");
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(linkProvider).mockResolvedValue(mockUser);
    vi.mocked(tryBootstrapAdmin).mockResolvedValue(false);
    vi.mocked(createAuthCode).mockResolvedValue(undefined as never);
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(exchangeGoogleCode).mockResolvedValue({ access_token: "google-at" } as never);
    vi.mocked(fetchGoogleUserInfo).mockResolvedValue({
      sub: "google-sub-1",
      email: "test@example.com",
      email_verified: true,
      name: "Test User",
      picture: "https://example.com/pic.jpg",
    } as never);
    vi.mocked(signCookie).mockImplementation(async (payload: string) =>
      btoa(encodeURIComponent(payload)),
    );
    vi.mocked(verifyCookie).mockImplementation(async (value: string) => {
      try {
        return decodeURIComponent(atob(decodeURIComponent(value)));
      } catch {
        return null;
      }
    });
  });

  it("Google: linkUserId指定 → linkProviderを呼び出す（upsertUserは呼ばない）", async () => {
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "google",
      linkUserId: "existing-user-id",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(302);
    expect(vi.mocked(linkProvider)).toHaveBeenCalledWith(
      expect.anything(),
      "existing-user-id",
      "google",
      "google-sub-1",
    );
    expect(vi.mocked(upsertUser)).not.toHaveBeenCalled();
  });

  it("Google: PROVIDER_ALREADY_LINKED → 409を返す", async () => {
    vi.mocked(linkProvider).mockRejectedValue(new Error("PROVIDER_ALREADY_LINKED"));
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "google",
      linkUserId: "existing-user-id",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("PROVIDER_ALREADY_LINKED");
  });

  it("LINE: linkUserId指定 → linkProviderを呼び出す", async () => {
    vi.mocked(exchangeLineCode).mockResolvedValue({ access_token: "line-at" } as never);
    vi.mocked(fetchLineUserInfo).mockResolvedValue({
      sub: "line-sub-new",
      name: "LINE User",
      picture: null,
      email: "line@example.com",
    } as never);
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "line",
      linkUserId: "existing-user-id",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(302);
    expect(vi.mocked(linkProvider)).toHaveBeenCalledWith(
      expect.anything(),
      "existing-user-id",
      "line",
      "line-sub-new",
    );
  });

  it("BAN済みユーザーのリンクフロー → 403を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue({ ...mockUser, banned_at: "2024-06-01T00:00:00Z" });
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "google",
      linkUserId: "existing-user-id",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("ACCOUNT_BANNED");
    expect(vi.mocked(linkProvider)).not.toHaveBeenCalled();
  });

  it("LINE: PROVIDER_ALREADY_LINKED → 409を返す", async () => {
    vi.mocked(linkProvider).mockRejectedValue(new Error("PROVIDER_ALREADY_LINKED"));
    vi.mocked(exchangeLineCode).mockResolvedValue({ access_token: "line-at" } as never);
    vi.mocked(fetchLineUserInfo).mockResolvedValue({
      sub: "line-sub-new",
      name: "LINE User",
      picture: null,
      email: "line@example.com",
    } as never);
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "line",
      linkUserId: "existing-user-id",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(409);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("PROVIDER_ALREADY_LINKED");
  });
});

// ===== GET /auth/callback - ブートストラップ管理者 =====
describe("GET /auth/callback - ブートストラップ管理者", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sha256).mockResolvedValue("hashed-value");
    vi.mocked(generateToken).mockReturnValue("mock-auth-code");
    vi.mocked(tryBootstrapAdmin).mockResolvedValue(true);
    vi.mocked(createAuthCode).mockResolvedValue(undefined as never);
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(exchangeGoogleCode).mockResolvedValue({ access_token: "google-at" } as never);
    vi.mocked(fetchGoogleUserInfo).mockResolvedValue({
      sub: "google-sub-1",
      email: "admin@example.com",
      email_verified: true,
      name: "Admin User",
      picture: null,
    } as never);
    vi.mocked(upsertUser).mockResolvedValue({
      ...mockUser,
      email: "admin@example.com",
      role: "user",
    });
    vi.mocked(signCookie).mockImplementation(async (payload: string) =>
      btoa(encodeURIComponent(payload)),
    );
    vi.mocked(verifyCookie).mockImplementation(async (value: string) => {
      try {
        return decodeURIComponent(atob(decodeURIComponent(value)));
      } catch {
        return null;
      }
    });
  });

  it("BOOTSTRAP_ADMIN_EMAIL一致・管理者0人 → tryBootstrapAdminを呼び出してadminに昇格", async () => {
    const envWithBootstrap = { ...mockEnv, BOOTSTRAP_ADMIN_EMAIL: "admin@example.com" };
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "google",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      envWithBootstrap,
    );
    expect(res.status).toBe(302);
    expect(vi.mocked(tryBootstrapAdmin)).toHaveBeenCalledWith(expect.anything(), "user-1");
  });

  it("BOOTSTRAP_ADMIN_EMAIL一致・既に管理者あり → 昇格しない（tryBootstrapAdminがfalseを返す）", async () => {
    vi.mocked(tryBootstrapAdmin).mockResolvedValue(false);
    const envWithBootstrap = { ...mockEnv, BOOTSTRAP_ADMIN_EMAIL: "admin@example.com" };
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "google",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      envWithBootstrap,
    );
    expect(res.status).toBe(302);
  });

  it("BOOTSTRAP_ADMIN_EMAILと不一致 → tryBootstrapAdminを呼ばない", async () => {
    const envWithBootstrap = { ...mockEnv, BOOTSTRAP_ADMIN_EMAIL: "other@example.com" };
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "google",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      envWithBootstrap,
    );
    expect(res.status).toBe(302);
    expect(vi.mocked(tryBootstrapAdmin)).not.toHaveBeenCalled();
  });

  it("BOOTSTRAP_ADMIN_EMAIL一致・tryBootstrapAdminがDB例外 → 500を返す", async () => {
    vi.mocked(tryBootstrapAdmin).mockRejectedValue(new Error("D1_ERROR: database is locked"));
    const envWithBootstrap = { ...mockEnv, BOOTSTRAP_ADMIN_EMAIL: "admin@example.com" };
    const stateData = buildStateCookie({
      idState: "correct-state",
      bffState: "bff-state",
      redirectTo: "https://user.0g0.xyz/callback",
      provider: "google",
    });
    const res = await buildApp().request(
      new Request(`${baseUrl}/auth/callback?code=auth-code&state=correct-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateData}; __Host-oauth-pkce=mock-verifier`,
        },
      }),
      undefined,
      envWithBootstrap,
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

// ===== isAllowedRedirectTo =====
describe("isAllowedRedirectTo", () => {
  const IDP = "https://id.0g0.xyz";

  it("同一親ドメインのサブドメインは許可", () => {
    expect(isAllowedRedirectTo("https://user.0g0.xyz/auth/callback", IDP)).toBe(true);
    expect(isAllowedRedirectTo("https://admin.0g0.xyz/auth/callback", IDP)).toBe(true);
    expect(isAllowedRedirectTo("https://rss.0g0.xyz/api/auth/callback", IDP)).toBe(true);
  });

  it("親ドメイン自身も許可", () => {
    expect(isAllowedRedirectTo("https://0g0.xyz/callback", IDP)).toBe(true);
  });

  it("全く異なるドメインは拒否", () => {
    expect(isAllowedRedirectTo("https://evil.com/callback", IDP)).toBe(false);
    expect(isAllowedRedirectTo("https://0g0.xyz.evil.com/callback", IDP)).toBe(false);
  });

  it("http:// は拒否（HTTPS必須）", () => {
    expect(isAllowedRedirectTo("http://rss.0g0.xyz/callback", IDP)).toBe(false);
  });

  it("不正なURLは拒否", () => {
    expect(isAllowedRedirectTo("not-a-url", IDP)).toBe(false);
    expect(isAllowedRedirectTo("", IDP)).toBe(false);
  });

  it("EXTRA_BFF_ORIGINS に一致するオリジンは許可", () => {
    expect(
      isAllowedRedirectTo(
        "https://external.example.com/callback",
        IDP,
        "https://external.example.com",
      ),
    ).toBe(true);
  });

  it("EXTRA_BFF_ORIGINS に一致しないオリジンは拒否", () => {
    expect(
      isAllowedRedirectTo(
        "https://other.example.com/callback",
        IDP,
        "https://external.example.com",
      ),
    ).toBe(false);
  });

  it("EXTRA_BFF_ORIGINS にカンマ区切りで複数指定できる", () => {
    const extras = "https://a.example.com,https://b.example.com";
    expect(isAllowedRedirectTo("https://a.example.com/cb", IDP, extras)).toBe(true);
    expect(isAllowedRedirectTo("https://b.example.com/cb", IDP, extras)).toBe(true);
    expect(isAllowedRedirectTo("https://c.example.com/cb", IDP, extras)).toBe(false);
  });

  it("IDP_ORIGIN が IPv4アドレスの場合、IPアドレスに基づく不正なドメイン派生を防ぐ", () => {
    // 127.0.0.1 → parentDomain が '0.0.1' になることを防ぐ
    const IDP_IP = "https://127.0.0.1:8787";
    // '.0.0.1' で終わるドメインへのリダイレクトは拒否されるべき
    expect(isAllowedRedirectTo("https://evil.0.0.1/callback", IDP_IP)).toBe(false);
    expect(isAllowedRedirectTo("https://0.0.1/callback", IDP_IP)).toBe(false);
    // EXTRA_BFF_ORIGINS での明示指定はOK
    expect(
      isAllowedRedirectTo("https://localhost:5173/callback", IDP_IP, "https://localhost:5173"),
    ).toBe(true);
  });

  it("IDP_ORIGIN が IPv6アドレスの場合も不正なドメイン派生を防ぐ", () => {
    const IDP_IPV6 = "https://[::1]:8787";
    expect(isAllowedRedirectTo("https://evil.example.com/callback", IDP_IPV6)).toBe(false);
    // EXTRA_BFF_ORIGINS での明示指定はOK
    expect(
      isAllowedRedirectTo("https://localhost:5173/callback", IDP_IPV6, "https://localhost:5173"),
    ).toBe(true);
  });

  it("Public Suffix List 対応: github.io のような PSL エントリは別登録ドメイン扱い", () => {
    // github.io は PSL 上の public suffix なので evil.github.io と good.github.io は別ドメイン
    // IDP が id.github.io であっても evil.github.io は許可しない
    const IDP_GITHUB_IO = "https://id.github.io";
    expect(isAllowedRedirectTo("https://id.github.io/callback", IDP_GITHUB_IO)).toBe(true);
    expect(isAllowedRedirectTo("https://evil.github.io/callback", IDP_GITHUB_IO)).toBe(false);
  });

  it("Public Suffix List 対応: co.uk のような 2 段 TLD でも正しい登録ドメインを使う", () => {
    // example.co.uk の IDP → *.example.co.uk は許可、evil.co.uk は拒否
    const IDP_CO_UK = "https://id.example.co.uk";
    expect(isAllowedRedirectTo("https://app.example.co.uk/callback", IDP_CO_UK)).toBe(true);
    expect(isAllowedRedirectTo("https://evil.co.uk/callback", IDP_CO_UK)).toBe(false);
  });
});

// ===== POST /auth/exchange — サービスOAuthフロー =====
describe("POST /auth/exchange (サービスOAuth)", () => {
  const app = buildApp();

  const mockService = {
    id: "service-1",
    name: "RSS App",
    client_id: "client-abc",
    client_secret_hash: "secret-hash-abc",
    allowed_scopes: "openid profile email",
    owner_user_id: "user-1",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    // serviceBindingMiddleware 通過用
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    // sha256 は呼び出し引数に応じて返す値を変える
    vi.mocked(sha256).mockImplementation(async (input: string) => {
      if (input === "my-secret") return "secret-hash-abc";
      return "hashed-code";
    });
    vi.mocked(generatePairwiseSub).mockResolvedValue("pairwise-sub-hash");
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
      id: "code-id",
      user_id: "user-1",
      service_id: "service-1",
      code_hash: "hashed-code",
      redirect_to: "https://rss.0g0.xyz/api/auth/callback",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      used_at: null,
      created_at: "2024-01-01T00:00:00Z",
    } as never);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(generateToken).mockReturnValue("mock-refresh-token");
    vi.mocked(findServiceByClientId).mockResolvedValue(mockService as never);
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    vi.mocked(signAccessToken).mockResolvedValue("mock-access-token");
    vi.mocked(signIdToken).mockResolvedValue("mock-id-token");
    vi.mocked(createRefreshToken).mockResolvedValue(undefined as never);
  });

  it("Authorization ヘッダーなし → 401を返す", async () => {
    const res = await sendRequest(app, "/auth/exchange", {
      method: "POST",
      body: { code: "valid-code", redirect_to: "https://rss.0g0.xyz/api/auth/callback" },
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("Basic 以外の Authorization → 401を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": "mock-internal-secret",
          Authorization: "Bearer some-token",
        },
        body: JSON.stringify({
          code: "valid-code",
          redirect_to: "https://rss.0g0.xyz/api/auth/callback",
        }),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(401);
  });

  it("不正な Base64 デコード → 401を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": "mock-internal-secret",
          Authorization: "Basic not-valid-base64!!!",
        },
        body: JSON.stringify({
          code: "valid-code",
          redirect_to: "https://rss.0g0.xyz/api/auth/callback",
        }),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(401);
  });

  it("client_id が存在しない → 401を返す", async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(null);
    const credentials = btoa("unknown-client:my-secret");
    const res = await app.request(
      new Request(`${baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": "mock-internal-secret",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({
          code: "valid-code",
          redirect_to: "https://rss.0g0.xyz/api/auth/callback",
        }),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("service_id が認可コードと不一致 → 401を返す", async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue({
      ...mockService,
      id: "other-service",
    } as never);
    const credentials = btoa("client-abc:my-secret");
    const res = await app.request(
      new Request(`${baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": "mock-internal-secret",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({
          code: "valid-code",
          redirect_to: "https://rss.0g0.xyz/api/auth/callback",
        }),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(401);
  });

  it("client_secret が不一致 → 401を返す", async () => {
    // 1回目: middleware の X-Internal-Secret 検証 → true、2回目以降: ルートハンドラの client_secret 比較 → false
    vi.mocked(timingSafeEqual).mockReturnValueOnce(true).mockReturnValue(false);
    const credentials = btoa("client-abc:wrong-secret");
    const res = await app.request(
      new Request(`${baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": "mock-internal-secret",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({
          code: "valid-code",
          redirect_to: "https://rss.0g0.xyz/api/auth/callback",
        }),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("認可コードのスコープが全て無効 → { error: { code: INVALID_SCOPE } } + 400", async () => {
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
      id: "code-id",
      user_id: "user-1",
      service_id: "service-1",
      code_hash: "hashed-code",
      redirect_to: "https://rss.0g0.xyz/api/auth/callback",
      scope: "address",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      used_at: null,
      created_at: "2024-01-01T00:00:00Z",
    } as never);
    vi.mocked(findServiceByClientId).mockResolvedValue({
      ...mockService,
      allowed_scopes: '["profile","email"]',
    } as never);
    const credentials = btoa("client-abc:my-secret");
    const res = await app.request(
      new Request(`${baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": "mock-internal-secret",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({
          code: "valid-code",
          redirect_to: "https://rss.0g0.xyz/api/auth/callback",
        }),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_SCOPE");
  });

  it("正常なサービスOAuth交換 → ペアワイズsubのIDトークンを含むレスポンスを返す", async () => {
    const credentials = btoa("client-abc:my-secret");
    const res = await app.request(
      new Request(`${baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": "mock-internal-secret",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({
          code: "valid-code",
          redirect_to: "https://rss.0g0.xyz/api/auth/callback",
        }),
      }),
      undefined,
      mockEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { access_token: string; id_token: string } }>();
    expect(body.data.access_token).toBe("mock-access-token");
    expect(body.data.id_token).toBe("mock-id-token");
    // ペアワイズ sub（sha256(client_id:user_id)）と aud = client_id で signIdToken が呼ばれること
    expect(vi.mocked(signIdToken)).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: "pairwise-sub-hash",
        aud: "client-abc",
      }),
      "mock-private-key",
      "mock-public-key",
    );
  });
});
// ===== GET /auth/authorize =====
describe("GET /auth/authorize", () => {
  const app = buildApp();

  const mockService = {
    id: "service-1",
    name: "Test Service",
    client_id: "client-abc",
    client_secret_hash: "hash",
    allowed_scopes: "openid profile email",
    owner_user_id: "owner-1",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };

  const validParams = new URLSearchParams({
    response_type: "code",
    client_id: "client-abc",
    redirect_uri: "https://app.example.com/callback",
    state: "random-state-value",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(findServiceByClientId).mockResolvedValue(mockService as never);
    vi.mocked(normalizeRedirectUri).mockImplementation((uri: string) => uri);
    vi.mocked(listRedirectUris).mockResolvedValue([
      {
        id: "uri-1",
        service_id: "service-1",
        uri: "https://app.example.com/callback",
        created_at: "2024-01-01T00:00:00Z",
      },
    ] as never);
    vi.mocked(matchRedirectUri).mockReturnValue(true);
  });

  it("response_type が code 以外 → 400を返す", async () => {
    const params = new URLSearchParams(validParams);
    params.set("response_type", "token");
    const res = await sendRequest(app, `/auth/authorize?${params.toString()}`);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("unsupported_response_type");
  });

  it("client_id 未指定 → 400を返す", async () => {
    const params = new URLSearchParams(validParams);
    params.delete("client_id");
    const res = await sendRequest(app, `/auth/authorize?${params.toString()}`);
    expect(res.status).toBe(400);
  });

  it("state 未指定 → 400を返す", async () => {
    const params = new URLSearchParams(validParams);
    params.delete("state");
    const res = await sendRequest(app, `/auth/authorize?${params.toString()}`);
    expect(res.status).toBe(400);
  });

  it("code_challenge 未指定 → 400を返す", async () => {
    const params = new URLSearchParams(validParams);
    params.delete("code_challenge");
    const res = await sendRequest(app, `/auth/authorize?${params.toString()}`);
    expect(res.status).toBe(400);
  });

  it("code_challenge_method が S256 以外 → 400を返す", async () => {
    const params = new URLSearchParams(validParams);
    params.set("code_challenge_method", "plain");
    const res = await sendRequest(app, `/auth/authorize?${params.toString()}`);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("invalid_request");
  });

  it("code_challenge が 43文字未満（RFC 7636 §4.2 違反） → 400を返す", async () => {
    const params = new URLSearchParams(validParams);
    params.set("code_challenge", "short-invalid-challenge");
    const res = await sendRequest(app, `/auth/authorize?${params.toString()}`);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; error_description: string }>();
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toContain("Invalid code_challenge format");
  });

  it("code_challenge が 43文字超（RFC 7636 §4.2 違反） → 400を返す", async () => {
    const params = new URLSearchParams(validParams);
    params.set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM-extra");
    const res = await sendRequest(app, `/auth/authorize?${params.toString()}`);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; error_description: string }>();
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toContain("Invalid code_challenge format");
  });

  it("未知の client_id → 400を返す", async () => {
    vi.mocked(findServiceByClientId).mockResolvedValue(null);
    const res = await sendRequest(app, `/auth/authorize?${validParams.toString()}`);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("invalid_request");
  });

  it("未登録の redirect_uri → 400を返す", async () => {
    vi.mocked(matchRedirectUri).mockReturnValue(false);
    const res = await sendRequest(app, `/auth/authorize?${validParams.toString()}`);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("invalid_request");
  });

  it("nonce が 128文字超 → 400を返す", async () => {
    const params = new URLSearchParams(validParams);
    params.set("nonce", "a".repeat(129));
    const res = await sendRequest(app, `/auth/authorize?${params.toString()}`);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("invalid_request");
  });

  it("nonce に制御文字が含まれる → 400を返す", async () => {
    const params = new URLSearchParams(validParams);
    params.set("nonce", "valid-prefix\x00injected");
    const res = await sendRequest(app, `/auth/authorize?${params.toString()}`);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; error_description: string }>();
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toContain("invalid characters");
  });

  it("nonce に改行文字が含まれる → 400を返す", async () => {
    const params = new URLSearchParams(validParams);
    params.set("nonce", "valid\ninjected");
    const res = await sendRequest(app, `/auth/authorize?${params.toString()}`);
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("invalid_request");
  });

  it("正常: USER_ORIGIN/login にリダイレクトする", async () => {
    const res = await sendRequest(app, `/auth/authorize?${validParams.toString()}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("https://user.0g0.xyz/login");
    expect(location).toContain("client_id=client-abc");
    expect(location).toContain("state=random-state-value");
    expect(location).toContain("code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("正常: nonce あり → リダイレクト先URLに nonce が含まれる", async () => {
    const params = new URLSearchParams(validParams);
    params.set("nonce", "test-nonce-value");
    const res = await sendRequest(app, `/auth/authorize?${params.toString()}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("nonce=test-nonce-value");
  });

  it("正常: nonce なし → リダイレクト先URLに nonce が含まれない", async () => {
    const res = await sendRequest(app, `/auth/authorize?${validParams.toString()}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).not.toContain("nonce=");
  });

  it("正常: scope あり → リダイレクト先URLに scope が含まれる", async () => {
    const params = new URLSearchParams(validParams);
    params.set("scope", "openid profile");
    const res = await sendRequest(app, `/auth/authorize?${params.toString()}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("scope=openid+profile");
  });

  it("findServiceByClientId がDB例外をスロー → RFC 6749形式のserver_error 500を返す", async () => {
    vi.mocked(findServiceByClientId).mockRejectedValue(new Error("D1_ERROR: database unavailable"));
    const res = await sendRequest(app, `/auth/authorize?${validParams.toString()}`);
    expect(res.status).toBe(500);
    const body = await res.json<{ error: string; error_description: string }>();
    expect(body.error).toBe("server_error");
    expect(body.error_description).toBe("Internal server error");
  });

  it("listRedirectUris がDB例外をスロー → RFC 6749形式のserver_error 500を返す", async () => {
    vi.mocked(listRedirectUris).mockRejectedValue(new Error("D1_ERROR: database unavailable"));
    const res = await sendRequest(app, `/auth/authorize?${validParams.toString()}`);
    expect(res.status).toBe(500);
    const body = await res.json<{ error: string; error_description: string }>();
    expect(body.error).toBe("server_error");
    expect(body.error_description).toBe("Internal server error");
  });
});

// ===== Authorization Code Flow E2E (State Cookie Round-trip) =====
describe("Authorization Code Flow E2E (State Cookie Round-trip)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Cookie署名モック（base64エンコード/デコードで署名をシミュレート）
    vi.mocked(signCookie).mockImplementation(async (payload: string) =>
      btoa(encodeURIComponent(payload)),
    );
    vi.mocked(verifyCookie).mockImplementation(async (value: string) => {
      try {
        return decodeURIComponent(atob(decodeURIComponent(value)));
      } catch {
        return null;
      }
    });
    // generateToken: 最初の呼び出し（login → idState）、以降（callback → auth code）
    vi.mocked(generateToken).mockReturnValueOnce("e2e-id-state").mockReturnValue("e2e-auth-code");
    vi.mocked(generateCodeVerifier).mockReturnValue("e2e-code-verifier");
    vi.mocked(generateCodeChallenge).mockResolvedValue("e2e-code-challenge");
    vi.mocked(buildGoogleAuthUrl).mockReturnValue(
      "https://accounts.google.com/o/oauth2/auth?state=e2e-id-state",
    );
    // OAuthプロバイダーモック
    vi.mocked(exchangeGoogleCode).mockResolvedValue({
      access_token: "google-access-token",
    } as never);
    vi.mocked(fetchGoogleUserInfo).mockResolvedValue({
      sub: "google-sub-1",
      email: "test@example.com",
      email_verified: true,
      name: "Test User",
      picture: "https://example.com/pic.jpg",
    } as never);
    // callbackのDBモック
    vi.mocked(upsertUser).mockResolvedValue(mockUser);
    vi.mocked(tryBootstrapAdmin).mockResolvedValue(false);
    vi.mocked(createAuthCode).mockResolvedValue(undefined as never);
    // timingSafeEqualは実際の文字列比較を実行（state round-trip検証のため）
    vi.mocked(timingSafeEqual).mockImplementation(((a: string, b: string) => a === b) as never);
    vi.mocked(sha256).mockResolvedValue("e2e-hashed-value");
    // exchangeのDBモック
    vi.mocked(findAndConsumeAuthCode).mockResolvedValue({
      id: "code-id",
      user_id: "user-1",
      service_id: null,
      code_hash: "e2e-hashed-value",
      redirect_to: "https://user.0g0.xyz/callback",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      used_at: null,
      created_at: "2024-01-01T00:00:00Z",
    } as never);
    vi.mocked(findUserById).mockResolvedValue(mockUser);
    vi.mocked(signAccessToken).mockResolvedValue("e2e-access-token");
    vi.mocked(signIdToken).mockResolvedValue("e2e-id-token");
    vi.mocked(createRefreshToken).mockResolvedValue(undefined as never);
  });

  it("/auth/login → /auth/callback → /auth/exchange: 完全なBFFフローでトークンが発行される", async () => {
    const app = buildApp();
    const bffState = "bff-test-state";
    const redirectTo = "https://user.0g0.xyz/callback";

    // Step 1: GET /auth/login
    const loginRes = await sendRequest(
      app,
      `/auth/login?redirect_to=${encodeURIComponent(redirectTo)}&state=${bffState}&provider=google`,
    );
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.get("location")).toContain("accounts.google.com");

    // Set-Cookieヘッダーからstate/pkce cookieを取得
    const setCookieHeader = loginRes.headers.get("set-cookie") ?? "";
    const stateCookieMatch = setCookieHeader.match(/__Host-oauth-state=([^;]+)/);
    const pkceCookieMatch = setCookieHeader.match(/__Host-oauth-pkce=([^;]+)/);
    expect(stateCookieMatch).not.toBeNull();
    expect(pkceCookieMatch).not.toBeNull();
    const stateCookieValue = stateCookieMatch![1];
    const pkceCookieValue = pkceCookieMatch![1];

    // Cookie内のstate情報を検証（sign/verify round-trip確認）
    const decodedState = JSON.parse(decodeURIComponent(atob(decodeURIComponent(stateCookieValue))));
    expect(decodedState.idState).toBe("e2e-id-state");
    expect(decodedState.bffState).toBe(bffState);
    expect(decodedState.redirectTo).toBe(redirectTo);
    expect(decodedState.provider).toBe("google");

    // Step 2: GET /auth/callback（OAuthプロバイダーからのコールバックをシミュレート）
    const callbackRes = await app.request(
      new Request(`${baseUrl}/auth/callback?code=google-oauth-code&state=e2e-id-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateCookieValue}; __Host-oauth-pkce=${pkceCookieValue}`,
        },
      }),
      undefined,
      mockEnv,
    );
    expect(callbackRes.status).toBe(302);
    const callbackLocation = callbackRes.headers.get("location") ?? "";
    expect(callbackLocation).toContain(redirectTo);
    expect(callbackLocation).toContain(`state=${bffState}`);

    // auth codeをリダイレクトURLから抽出
    const callbackUrl = new URL(callbackLocation);
    const authCode = callbackUrl.searchParams.get("code");
    expect(authCode).toBe("e2e-auth-code");

    // createAuthCodeがcallback時に呼ばれたことを確認
    expect(vi.mocked(createAuthCode)).toHaveBeenCalled();

    // Step 3: POST /auth/exchange（BFFがauth codeをトークンに交換）
    const exchangeRes = await sendRequest(app, "/auth/exchange", {
      method: "POST",
      body: { code: authCode, redirect_to: redirectTo },
    });
    expect(exchangeRes.status).toBe(200);
    const exchangeBody = await exchangeRes.json<{
      data: {
        access_token: string;
        id_token: string;
        token_type: string;
        expires_in: number;
        user: { id: string; email: string };
      };
    }>();
    expect(exchangeBody.data.access_token).toBe("e2e-access-token");
    expect(exchangeBody.data.id_token).toBe("e2e-id-token");
    expect(exchangeBody.data.token_type).toBe("Bearer");
    expect(exchangeBody.data.user.id).toBe("user-1");
    expect(exchangeBody.data.user.email).toBe("test@example.com");
  });

  it("/auth/login → /auth/callback（state不一致）: CSRF攻撃シミュレーションで400を返す", async () => {
    const app = buildApp();
    const redirectTo = "https://user.0g0.xyz/callback";

    // Step 1: GET /auth/login（正規フロー）
    const loginRes = await sendRequest(
      app,
      `/auth/login?redirect_to=${encodeURIComponent(redirectTo)}&state=legitimate-bff-state&provider=google`,
    );
    expect(loginRes.status).toBe(302);

    const setCookieHeader = loginRes.headers.get("set-cookie") ?? "";
    const stateCookieMatch = setCookieHeader.match(/__Host-oauth-state=([^;]+)/);
    const pkceCookieMatch = setCookieHeader.match(/__Host-oauth-pkce=([^;]+)/);
    expect(stateCookieMatch).not.toBeNull();
    const stateCookieValue = stateCookieMatch![1];
    const pkceCookieValue = pkceCookieMatch?.[1] ?? "dummy-pkce";

    // Step 2: 攻撃者が異なるstateでコールバックを送信（CSRF攻撃）
    const callbackRes = await app.request(
      new Request(`${baseUrl}/auth/callback?code=google-oauth-code&state=attacker-injected-state`, {
        headers: {
          Cookie: `__Host-oauth-state=${stateCookieValue}; __Host-oauth-pkce=${pkceCookieValue}`,
        },
      }),
      undefined,
      mockEnv,
    );
    // state不一致（idState='e2e-id-state' vs 'attacker-injected-state'）で400を返すこと
    expect(callbackRes.status).toBe(400);
    const body = await callbackRes.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    // トークン発行が呼ばれないことを確認
    expect(vi.mocked(createAuthCode)).not.toHaveBeenCalled();
  });
});
