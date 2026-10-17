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
  };
});

vi.mock("../../utils/scopes", () => ({
  validateNonce: vi.fn(),
  validateCodeChallengeParams: vi.fn(),
}));

vi.mock("../../utils/auth-helpers", () => ({
  validateServiceRedirectUri: vi.fn(),
}));

import { validateNonce, validateCodeChallengeParams } from "../../utils/scopes";
import { validateServiceRedirectUri } from "../../utils/auth-helpers";
import { handleAuthorize } from "./authorize";

// --- テスト用定数 ---
const mockEnv = createMockIdpEnv();

const validParams: Record<string, string> = {
  response_type: "code",
  client_id: "test-client",
  redirect_uri: "https://example.com/callback",
  state: "random-state",
  code_challenge: "challenge-value",
};

// --- ヘルパー ---
function buildApp() {
  const app = new Hono<{ Bindings: ReturnType<typeof createMockIdpEnv> }>();
  app.get("/auth/authorize", handleAuthorize);
  return app;
}

function makeRequest(params: Record<string, string>) {
  const app = buildApp();
  const url = new URL("https://id.0g0.xyz/auth/authorize");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return app.request(new Request(url.toString()), undefined, mockEnv);
}

// --- テスト ---
describe("GET /auth/authorize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateCodeChallengeParams).mockReturnValue(null);
    vi.mocked(validateNonce).mockReturnValue(null);
    vi.mocked(validateServiceRedirectUri).mockResolvedValue({
      ok: true,
      serviceId: "svc-1",
    });
  });

  // =====================
  // response_type 検証
  // =====================
  describe("response_type 検証", () => {
    it("response_type 未指定 → 400 unsupported_response_type", async () => {
      const { response_type: _, ...params } = validParams;
      const res = await makeRequest(params);
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe("unsupported_response_type");
    });

    it("response_type が code 以外 → 400 unsupported_response_type", async () => {
      const res = await makeRequest({ ...validParams, response_type: "token" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe("unsupported_response_type");
    });
  });

  // =====================
  // 必須パラメータ検証
  // =====================
  describe("必須パラメータ検証", () => {
    it("client_id 未指定 → 400 invalid_request", async () => {
      const { client_id: _, ...params } = validParams;
      const res = await makeRequest(params);
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string; error_description: string }>();
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain("client_id");
    });

    it("redirect_uri 未指定 → 400 invalid_request", async () => {
      const { redirect_uri: _, ...params } = validParams;
      const res = await makeRequest(params);
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string; error_description: string }>();
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain("redirect_uri");
    });

    it("state 未指定 → 400 invalid_request", async () => {
      const { state: _, ...params } = validParams;
      const res = await makeRequest(params);
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string; error_description: string }>();
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain("state");
    });

    it("code_challenge 未指定 → 400 invalid_request", async () => {
      const { code_challenge: _, ...params } = validParams;
      const res = await makeRequest(params);
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string; error_description: string }>();
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain("code_challenge");
    });
  });

  // =====================
  // code_challenge バリデーション
  // =====================
  describe("code_challenge バリデーション", () => {
    it("validateCodeChallengeParams がエラーを返す → 400 invalid_request", async () => {
      vi.mocked(validateCodeChallengeParams).mockReturnValue("Only S256 is supported");

      const res = await makeRequest(validParams);
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string; error_description: string }>();
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toBe("Only S256 is supported");
    });
  });

  // =====================
  // パラメータ長制限
  // =====================
  describe("パラメータ長制限", () => {
    it("redirect_uri が 2048 文字超 → 400 invalid_request", async () => {
      const res = await makeRequest({
        ...validParams,
        redirect_uri: "https://example.com/" + "a".repeat(2048),
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string; error_description: string }>();
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain("redirect_uri");
    });

    it("state が 1024 文字超 → 400 invalid_request", async () => {
      const res = await makeRequest({
        ...validParams,
        state: "s".repeat(1025),
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string; error_description: string }>();
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain("state");
    });

    it("scope が 2048 文字超 → 400 invalid_request", async () => {
      const res = await makeRequest({
        ...validParams,
        scope: "s".repeat(2049),
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string; error_description: string }>();
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain("scope");
    });
  });

  // =====================
  // nonce バリデーション
  // =====================
  describe("nonce バリデーション", () => {
    it("validateNonce がエラーを返す → 400 invalid_request", async () => {
      vi.mocked(validateNonce).mockReturnValue("nonce too long");

      const res = await makeRequest({ ...validParams, nonce: "x".repeat(200) });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string; error_description: string }>();
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toBe("nonce too long");
    });
  });

  // =====================
  // サービスリダイレクトURI検証
  // =====================
  describe("サービスリダイレクトURI検証", () => {
    it("validateServiceRedirectUri が例外を投げる → 500 server_error", async () => {
      vi.mocked(validateServiceRedirectUri).mockRejectedValue(new Error("DB error"));

      const res = await makeRequest(validParams);
      expect(res.status).toBe(500);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe("server_error");
    });

    it("validateServiceRedirectUri が ok: false を返す → 400 invalid_request", async () => {
      vi.mocked(validateServiceRedirectUri).mockResolvedValue({
        ok: false,
        error: "redirect_uri not registered for this client",
      });

      const res = await makeRequest(validParams);
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string; error_description: string }>();
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toBe("redirect_uri not registered for this client");
    });
  });

  // =====================
  // 正常系
  // =====================
  describe("正常系", () => {
    it("全パラメータ正常 → 302 USER_ORIGIN/login にリダイレクト", async () => {
      const res = await makeRequest(validParams);
      expect(res.status).toBe(302);
      const location = res.headers.get("Location");
      expect(location).toBeTruthy();

      const redirectUrl = new URL(location!);
      expect(redirectUrl.pathname).toBe("/login");
      expect(redirectUrl.searchParams.get("service_id")).toBe("svc-1");
      expect(redirectUrl.searchParams.get("client_id")).toBe("test-client");
      expect(redirectUrl.searchParams.get("redirect_uri")).toBe("https://example.com/callback");
      expect(redirectUrl.searchParams.get("state")).toBe("random-state");
      expect(redirectUrl.searchParams.get("code_challenge")).toBe("challenge-value");
      expect(redirectUrl.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("scope 指定時 → リダイレクトURLに scope が含まれる", async () => {
      const res = await makeRequest({ ...validParams, scope: "openid profile" });
      expect(res.status).toBe(302);
      const location = res.headers.get("Location");
      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get("scope")).toBe("openid profile");
    });

    it("nonce 指定時 → リダイレクトURLに nonce が含まれる", async () => {
      const res = await makeRequest({ ...validParams, nonce: "test-nonce-123" });
      expect(res.status).toBe(302);
      const location = res.headers.get("Location");
      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get("nonce")).toBe("test-nonce-123");
    });

    it("scope・nonce 未指定時 → リダイレクトURLに含まれない", async () => {
      const res = await makeRequest(validParams);
      expect(res.status).toBe(302);
      const location = res.headers.get("Location");
      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.has("scope")).toBe(false);
      expect(redirectUrl.searchParams.has("nonce")).toBe(false);
    });
  });
});
