import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

// --- モック定義 ---
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...original,
    generateCodeVerifier: vi.fn().mockReturnValue("mock-code-verifier"),
    generateCodeChallenge: vi.fn().mockResolvedValue("mock-code-challenge"),
    generateToken: vi.fn().mockReturnValue("mock-id-state"),
    signCookie: vi.fn().mockResolvedValue("signed-cookie-value"),
    verifyCookie: vi.fn(),
    buildGoogleAuthUrl: vi.fn().mockReturnValue("https://accounts.google.com/o/oauth2/auth?mock=1"),
    buildLineAuthUrl: vi
      .fn()
      .mockReturnValue("https://access.line.me/oauth2/v2.1/authorize?mock=1"),
    buildTwitchAuthUrl: vi.fn().mockReturnValue("https://id.twitch.tv/oauth2/authorize?mock=1"),
    buildGithubAuthUrl: vi.fn().mockReturnValue("https://github.com/login/oauth/authorize?mock=1"),
    buildXAuthUrl: vi.fn().mockReturnValue("https://x.com/i/oauth2/authorize?mock=1"),
    isValidProvider: vi.fn().mockReturnValue(true),
  };
});

vi.mock("../../utils/scopes", () => ({
  validateNonce: vi.fn().mockReturnValue(null),
  validateCodeChallengeParams: vi.fn().mockReturnValue(null),
}));

vi.mock("../../utils/auth-helpers", () => ({
  CALLBACK_PATH: "/auth/callback",
  STATE_COOKIE: "__Host-idp-state",
  PKCE_COOKIE: "__Host-idp-pkce",
  isAllowedRedirectTo: vi.fn().mockReturnValue(false),
  isBffOrigin: vi.fn().mockReturnValue(true),
  setSecureCookie: vi.fn(),
  validateProviderCredentials: vi.fn().mockReturnValue({ ok: true }),
  validateServiceRedirectUri: vi.fn().mockResolvedValue({ ok: true, serviceId: "svc-1" }),
}));

vi.mock("../../utils/validation", () => ({
  validateRequiredParams: vi.fn().mockReturnValue(null),
  validateParamLengths: vi.fn().mockReturnValue(null),
}));

import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateToken,
  signCookie,
  verifyCookie,
  buildGoogleAuthUrl,
  buildLineAuthUrl,
  isValidProvider,
} from "@0g0-id/shared";
import { validateNonce, validateCodeChallengeParams } from "../../utils/scopes";
import {
  isAllowedRedirectTo,
  isBffOrigin,
  setSecureCookie,
  validateProviderCredentials,
  validateServiceRedirectUri,
} from "../../utils/auth-helpers";
import { validateRequiredParams, validateParamLengths } from "../../utils/validation";
import { handleLogin } from "./login";

// --- テスト用定数 ---
const mockEnv = createMockIdpEnv();

const validParams: Record<string, string> = {
  redirect_to: "https://user.0g0.xyz/callback",
  state: "bff-state-123",
  provider: "google",
};

// --- ヘルパー ---
function buildApp() {
  const app = new Hono<{ Bindings: ReturnType<typeof createMockIdpEnv> }>();
  app.get("/auth/login", handleLogin);
  return app;
}

function makeRequest(params: Record<string, string>) {
  const app = buildApp();
  const url = new URL("https://id.0g0.xyz/auth/login");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return app.request(new Request(url.toString()), undefined, mockEnv);
}

// --- テスト ---
describe("GET /auth/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // デフォルト: すべてのバリデーションを通過させる
    vi.mocked(validateRequiredParams).mockReturnValue(null);
    vi.mocked(validateParamLengths).mockReturnValue(null);
    vi.mocked(isValidProvider).mockReturnValue(true);
    vi.mocked(validateProviderCredentials).mockReturnValue({ ok: true });
    vi.mocked(isBffOrigin).mockReturnValue(true);
    vi.mocked(isAllowedRedirectTo).mockReturnValue(false);
    vi.mocked(validateNonce).mockReturnValue(null);
    vi.mocked(validateCodeChallengeParams).mockReturnValue(null);
    vi.mocked(verifyCookie).mockResolvedValue(null);
    vi.mocked(generateToken).mockReturnValue("mock-id-state");
    vi.mocked(generateCodeVerifier).mockReturnValue("mock-code-verifier");
    vi.mocked(generateCodeChallenge).mockResolvedValue("mock-code-challenge");
    vi.mocked(signCookie).mockResolvedValue("signed-cookie-value");
    vi.mocked(buildGoogleAuthUrl).mockReturnValue(
      "https://accounts.google.com/o/oauth2/auth?mock=1",
    );
    vi.mocked(buildLineAuthUrl).mockReturnValue(
      "https://access.line.me/oauth2/v2.1/authorize?mock=1",
    );
  });

  // =====================
  // バリデーション
  // =====================
  describe("バリデーション", () => {
    it("redirect_to が未指定 → 400", async () => {
      const errorResponse = Response.json(
        { error: { code: "BAD_REQUEST", message: "Missing required parameters" } },
        { status: 400 },
      );
      vi.mocked(validateRequiredParams).mockReturnValue(errorResponse);

      const res = await makeRequest({ state: "bff-state-123", provider: "google" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("state が未指定 → 400", async () => {
      const errorResponse = Response.json(
        { error: { code: "BAD_REQUEST", message: "Missing required parameters" } },
        { status: 400 },
      );
      vi.mocked(validateRequiredParams).mockReturnValue(errorResponse);

      const res = await makeRequest({ redirect_to: "https://user.0g0.xyz/callback" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("redirect_to が長すぎる → 400", async () => {
      const errorResponse = Response.json(
        { error: { code: "BAD_REQUEST", message: "redirect_to too long" } },
        { status: 400 },
      );
      vi.mocked(validateParamLengths).mockReturnValue(errorResponse);

      const res = await makeRequest(validParams);
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("redirect_to too long");
    });

    it("無効なプロバイダー → 400 BAD_REQUEST 'Invalid provider'", async () => {
      vi.mocked(isValidProvider).mockReturnValue(false);

      const res = await makeRequest({ ...validParams, provider: "invalid" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Invalid provider");
    });

    it("プロバイダー資格情報が未設定 → 400", async () => {
      vi.mocked(validateProviderCredentials).mockReturnValue({
        ok: false,
        code: "PROVIDER_NOT_CONFIGURED",
        message: "Line provider is not configured",
      });

      const res = await makeRequest({ ...validParams, provider: "line" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("PROVIDER_NOT_CONFIGURED");
    });
  });

  // =====================
  // redirect_to 検証
  // =====================
  describe("redirect_to 検証", () => {
    it("client_id あり + validateServiceRedirectUri 失敗 → 400", async () => {
      vi.mocked(validateServiceRedirectUri).mockResolvedValue({
        ok: false,
        error: "Invalid client_id",
      });

      const res = await makeRequest({ ...validParams, client_id: "bad-client" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Invalid client_id");
    });

    it("client_id なし + BFF オリジンでない + 不明ドメイン → 400 'Invalid redirect_to'", async () => {
      vi.mocked(isBffOrigin).mockReturnValue(false);
      vi.mocked(isAllowedRedirectTo).mockReturnValue(false);

      const res = await makeRequest({
        ...validParams,
        redirect_to: "https://evil.example.com/callback",
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Invalid redirect_to");
    });

    it("client_id なし + BFF オリジンでない + 既知ドメイン → 400 'client_id is required for external services'", async () => {
      vi.mocked(isBffOrigin).mockReturnValue(false);
      vi.mocked(isAllowedRedirectTo).mockReturnValue(true);

      const res = await makeRequest({
        ...validParams,
        redirect_to: "https://rss.0g0.xyz/callback",
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("client_id is required for external services");
    });
  });

  // =====================
  // OIDC オプションパラメータ
  // =====================
  describe("OIDC オプションパラメータ", () => {
    it("無効な nonce → 400", async () => {
      vi.mocked(validateNonce).mockReturnValue("nonce too long");

      const res = await makeRequest({ ...validParams, nonce: "x".repeat(200) });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("nonce too long");
    });

    it("無効な code_challenge → 400", async () => {
      vi.mocked(validateCodeChallengeParams).mockReturnValue(
        "Only S256 code_challenge_method is supported",
      );

      const res = await makeRequest({
        ...validParams,
        code_challenge: "abc",
        code_challenge_method: "plain",
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Only S256 code_challenge_method is supported");
    });
  });

  // =====================
  // link_token 検証
  // =====================
  describe("link_token 検証", () => {
    it("無効な link_token (verifyCookie 失敗) → 400 INVALID_LINK_TOKEN", async () => {
      vi.mocked(verifyCookie).mockResolvedValue(null);

      const res = await makeRequest({ ...validParams, link_token: "bad-token" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("INVALID_LINK_TOKEN");
      expect(body.error.message).toBe("Invalid or expired link token");
    });

    it("link_token の purpose が不正 → 400 INVALID_LINK_TOKEN", async () => {
      vi.mocked(verifyCookie).mockResolvedValue(
        JSON.stringify({ purpose: "wrong", sub: "user-1", exp: Date.now() + 60000 }),
      );

      const res = await makeRequest({ ...validParams, link_token: "signed-token" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_LINK_TOKEN");
    });

    it("link_token が期限切れ → 400 INVALID_LINK_TOKEN", async () => {
      vi.mocked(verifyCookie).mockResolvedValue(
        JSON.stringify({ purpose: "link", sub: "user-1", exp: Date.now() - 60000 }),
      );

      const res = await makeRequest({ ...validParams, link_token: "signed-token" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_LINK_TOKEN");
    });
  });

  // =====================
  // 正常系
  // =====================
  describe("正常系", () => {
    it("Google (デフォルト) → 302 リダイレクト", async () => {
      const res = await makeRequest(validParams);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://accounts.google.com/o/oauth2/auth?mock=1");

      // state/PKCE の生成が呼ばれたことを確認
      expect(generateToken).toHaveBeenCalledWith(16);
      expect(generateCodeVerifier).toHaveBeenCalled();
      expect(generateCodeChallenge).toHaveBeenCalledWith("mock-code-verifier");

      // Cookie の設定が呼ばれたことを確認
      expect(signCookie).toHaveBeenCalledTimes(2);
      expect(setSecureCookie).toHaveBeenCalledTimes(2);

      // buildGoogleAuthUrl に正しいパラメータが渡されたことを確認
      expect(buildGoogleAuthUrl).toHaveBeenCalledWith({
        redirectUri: `${mockEnv.IDP_ORIGIN}/auth/callback`,
        state: "mock-id-state",
        codeChallenge: "mock-code-challenge",
        clientId: mockEnv.GOOGLE_CLIENT_ID,
      });
    });

    it("Line プロバイダー → 302 リダイレクト", async () => {
      const res = await makeRequest({ ...validParams, provider: "line" });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://access.line.me/oauth2/v2.1/authorize?mock=1",
      );
      expect(buildLineAuthUrl).toHaveBeenCalledWith({
        redirectUri: `${mockEnv.IDP_ORIGIN}/auth/callback`,
        state: "mock-id-state",
        codeChallenge: "mock-code-challenge",
        clientId: mockEnv.LINE_CLIENT_ID,
      });
    });

    it("有効な link_token 付き → 302 リダイレクト（statePayload に linkUserId を含む）", async () => {
      vi.mocked(verifyCookie).mockResolvedValue(
        JSON.stringify({ purpose: "link", sub: "user-link-1", exp: Date.now() + 60000 }),
      );

      const res = await makeRequest({ ...validParams, link_token: "valid-link-token" });
      expect(res.status).toBe(302);

      // signCookie に渡された statePayload に linkUserId が含まれていることを確認
      const signCookieCalls = vi.mocked(signCookie).mock.calls;
      const statePayloadJson = signCookieCalls[0][0];
      const statePayload = JSON.parse(statePayloadJson) as Record<string, unknown>;
      expect(statePayload.linkUserId).toBe("user-link-1");
    });

    it("client_id 付き → 302 リダイレクト（statePayload に serviceId を含む）", async () => {
      vi.mocked(validateServiceRedirectUri).mockResolvedValue({
        ok: true,
        serviceId: "svc-ext-1",
      });

      const res = await makeRequest({ ...validParams, client_id: "valid-client" });
      expect(res.status).toBe(302);

      // signCookie に渡された statePayload に serviceId が含まれていることを確認
      const signCookieCalls = vi.mocked(signCookie).mock.calls;
      const statePayloadJson = signCookieCalls[0][0];
      const statePayload = JSON.parse(statePayloadJson) as Record<string, unknown>;
      expect(statePayload.serviceId).toBe("svc-ext-1");
    });
  });
});
