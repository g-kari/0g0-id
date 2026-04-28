import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import type { BffEnv } from "../types";

// モック設定
vi.mock("./crypto", () => ({ generateToken: vi.fn() }));
vi.mock("./bff", () => ({
  parseSession: vi.fn(),
  setSessionCookie: vi.fn(),
  exchangeCodeAtIdp: vi.fn(),
  revokeTokenAtIdp: vi.fn(),
  SESSION_COOKIE_DELETE_OPTIONS: { path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
  setOAuthStateCookie: vi.fn(),
  verifyAndConsumeOAuthState: vi.fn(),
}));
vi.mock("./logger", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));
vi.mock("./dbsc", () => ({ buildSecureSessionRegistrationHeader: vi.fn() }));
vi.mock("hono/cookie", () => ({
  getCookie: vi.fn(),
  deleteCookie: vi.fn(),
  setCookie: vi.fn(),
}));

import { generateToken } from "./crypto";
import {
  parseSession,
  setSessionCookie,
  exchangeCodeAtIdp,
  revokeTokenAtIdp,
  setOAuthStateCookie,
  verifyAndConsumeOAuthState,
} from "./bff";
import { getCookie, deleteCookie } from "hono/cookie";
import { buildSecureSessionRegistrationHeader } from "./dbsc";
import { createBffAuthRoutes } from "./bff-auth-factory";
import type { BffAuthConfig } from "./bff-auth-factory";

const mockEnv: BffEnv = {
  IDP: { fetch: vi.fn() } as unknown as BffEnv["IDP"],
  IDP_ORIGIN: "https://id.0g0.xyz",
  SELF_ORIGIN: "https://user.0g0.xyz",
  SESSION_SECRET: "test-secret-32-characters-long!!",
  INTERNAL_SERVICE_SECRET_SELF: "internal-secret",
};

const baseConfig: BffAuthConfig = {
  sessionCookieName: "__Host-session",
  stateCookieName: "__Host-oauth-state",
  loggerName: "test-auth",
  successRedirect: "/dashboard",
};

function createTestApp(config: BffAuthConfig = baseConfig): Hono<{ Bindings: BffEnv }> {
  const authRoutes = createBffAuthRoutes(config);
  const app = new Hono<{ Bindings: BffEnv }>();
  app.route("/auth", authRoutes);
  return app;
}

function makeRequest(app: Hono<{ Bindings: BffEnv }>, path: string, init?: RequestInit) {
  return app.request(path, init, mockEnv) as Promise<Response>;
}

describe("createBffAuthRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /login ───

  describe("GET /auth/login", () => {
    it("state tokenを生成しIdPにリダイレクトする", async () => {
      vi.mocked(generateToken).mockReturnValue("random-state-token");

      const app = createTestApp();
      const res = await makeRequest(app, "/auth/login");

      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("https://id.0g0.xyz/auth/login");
      expect(location).toContain("redirect_to=https%3A%2F%2Fuser.0g0.xyz%2Fauth%2Fcallback");
      expect(location).toContain("state=random-state-token");
      expect(vi.mocked(setOAuthStateCookie)).toHaveBeenCalledOnce();
      expect(vi.mocked(setOAuthStateCookie).mock.calls[0][1]).toBe("__Host-oauth-state");
      expect(vi.mocked(setOAuthStateCookie).mock.calls[0][2]).toBe("random-state-token");
    });

    it("loginParamsで追加パラメータをリダイレクトURLに付与する", async () => {
      vi.mocked(generateToken).mockReturnValue("state-123");

      const config: BffAuthConfig = {
        ...baseConfig,
        loginParams: () => ({ provider: "google", prompt: "consent" }),
      };
      const app = createTestApp(config);
      const res = await makeRequest(app, "/auth/login");

      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("provider=google");
      expect(location).toContain("prompt=consent");
    });

    it("loginParamsがResponseを返した場合はそのResponseを返す", async () => {
      vi.mocked(generateToken).mockReturnValue("state-123");

      const config: BffAuthConfig = {
        ...baseConfig,
        loginParams: (c) => c.redirect("/?error=invalid_provider"),
      };
      const app = createTestApp(config);
      const res = await makeRequest(app, "/auth/login");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=invalid_provider");
    });
  });

  // ─── GET /callback ───

  describe("GET /auth/callback", () => {
    it("codeまたはstateがない場合は?error=missing_paramsにリダイレクトする", async () => {
      const app = createTestApp();

      // code も state もなし
      const res1 = await makeRequest(app, "/auth/callback");
      expect(res1.status).toBe(302);
      expect(res1.headers.get("Location")).toBe("/?error=missing_params");

      // code のみ
      const res2 = await makeRequest(app, "/auth/callback?code=abc");
      expect(res2.status).toBe(302);
      expect(res2.headers.get("Location")).toBe("/?error=missing_params");

      // state のみ
      const res3 = await makeRequest(app, "/auth/callback?state=xyz");
      expect(res3.status).toBe(302);
      expect(res3.headers.get("Location")).toBe("/?error=missing_params");
    });

    it("state検証エラーの場合はそのエラーコードでリダイレクトする", async () => {
      vi.mocked(verifyAndConsumeOAuthState).mockReturnValue("state_mismatch");

      const app = createTestApp();
      const res = await makeRequest(app, "/auth/callback?code=abc&state=xyz");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=state_mismatch");
    });

    it("コード交換が失敗した場合は?error=exchange_failedにリダイレクトする", async () => {
      vi.mocked(verifyAndConsumeOAuthState).mockReturnValue(null);
      vi.mocked(exchangeCodeAtIdp).mockResolvedValue({ ok: false as const });

      const app = createTestApp();
      const res = await makeRequest(app, "/auth/callback?code=abc&state=xyz");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=exchange_failed");
    });

    it("onCallbackCheckがResponseを返した場合はそのResponseを返す", async () => {
      vi.mocked(verifyAndConsumeOAuthState).mockReturnValue(null);
      vi.mocked(exchangeCodeAtIdp).mockResolvedValue({
        ok: true as const,
        data: {
          access_token: "at",
          refresh_token: "rt",
          session_id: "sid",
          user: { id: "u1", email: "e@e.com", name: "N", role: "user" },
        },
      });

      const config: BffAuthConfig = {
        ...baseConfig,
        onCallbackCheck: async (c) => c.redirect("/?error=not_admin"),
      };
      const app = createTestApp(config);
      const res = await makeRequest(app, "/auth/callback?code=abc&state=xyz");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=not_admin");
    });

    it("session_idが返されない場合は?error=exchange_failedにリダイレクトする", async () => {
      vi.mocked(verifyAndConsumeOAuthState).mockReturnValue(null);
      vi.mocked(exchangeCodeAtIdp).mockResolvedValue({
        ok: true as const,
        data: {
          access_token: "at",
          refresh_token: "rt",
          // session_id なし
          user: { id: "u1", email: "e@e.com", name: "N", role: "user" },
        },
      });

      const app = createTestApp();
      const res = await makeRequest(app, "/auth/callback?code=abc&state=xyz");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/?error=exchange_failed");
    });

    it("成功時にセッションCookieを設定してリダイレクトする", async () => {
      vi.mocked(verifyAndConsumeOAuthState).mockReturnValue(null);
      vi.mocked(exchangeCodeAtIdp).mockResolvedValue({
        ok: true as const,
        data: {
          access_token: "at-123",
          refresh_token: "rt-456",
          session_id: "sid-789",
          user: { id: "u1", email: "e@e.com", name: "Test", role: "user" },
        },
      });

      const app = createTestApp();
      const res = await makeRequest(app, "/auth/callback?code=abc&state=xyz");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dashboard");
      expect(vi.mocked(setSessionCookie)).toHaveBeenCalledOnce();
      const sessionArg = vi.mocked(setSessionCookie).mock.calls[0][2];
      expect(sessionArg).toMatchObject({
        session_id: "sid-789",
        access_token: "at-123",
        refresh_token: "rt-456",
        user: { id: "u1", email: "e@e.com", name: "Test", role: "user" },
      });
    });

    it("dbscRegistrationPathが設定されている場合はSecure-Session-Registrationヘッダを付与する", async () => {
      vi.mocked(verifyAndConsumeOAuthState).mockReturnValue(null);
      vi.mocked(exchangeCodeAtIdp).mockResolvedValue({
        ok: true as const,
        data: {
          access_token: "at",
          refresh_token: "rt",
          session_id: "sid",
          user: { id: "u1", email: "e@e.com", name: "N", role: "user" },
        },
      });
      vi.mocked(buildSecureSessionRegistrationHeader).mockReturnValue(
        '("ES256");path="/auth/dbsc-registration"',
      );

      const config: BffAuthConfig = {
        ...baseConfig,
        dbscRegistrationPath: "/auth/dbsc-registration",
      };
      const app = createTestApp(config);
      const res = await makeRequest(app, "/auth/callback?code=abc&state=xyz");

      expect(res.status).toBe(302);
      expect(res.headers.get("Secure-Session-Registration")).toBe(
        '("ES256");path="/auth/dbsc-registration"',
      );
      expect(vi.mocked(buildSecureSessionRegistrationHeader)).toHaveBeenCalledWith({
        path: "/auth/dbsc-registration",
      });
    });

    it("dbscRegistrationPathが未設定の場合はSecure-Session-Registrationヘッダを付与しない", async () => {
      vi.mocked(verifyAndConsumeOAuthState).mockReturnValue(null);
      vi.mocked(exchangeCodeAtIdp).mockResolvedValue({
        ok: true as const,
        data: {
          access_token: "at",
          refresh_token: "rt",
          session_id: "sid",
          user: { id: "u1", email: "e@e.com", name: "N", role: "user" },
        },
      });

      const app = createTestApp();
      const res = await makeRequest(app, "/auth/callback?code=abc&state=xyz");

      expect(res.status).toBe(302);
      expect(res.headers.get("Secure-Session-Registration")).toBeNull();
      expect(vi.mocked(buildSecureSessionRegistrationHeader)).not.toHaveBeenCalled();
    });

    it("onCallbackCheckがnullを返した場合は通常の成功フローを続行する", async () => {
      vi.mocked(verifyAndConsumeOAuthState).mockReturnValue(null);
      vi.mocked(exchangeCodeAtIdp).mockResolvedValue({
        ok: true as const,
        data: {
          access_token: "at",
          refresh_token: "rt",
          session_id: "sid",
          user: { id: "u1", email: "e@e.com", name: "N", role: "admin" },
        },
      });

      const config: BffAuthConfig = {
        ...baseConfig,
        onCallbackCheck: async () => null,
      };
      const app = createTestApp(config);
      const res = await makeRequest(app, "/auth/callback?code=abc&state=xyz");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dashboard");
      expect(vi.mocked(setSessionCookie)).toHaveBeenCalledOnce();
    });
  });

  // ─── POST /logout ───

  describe("POST /auth/logout", () => {
    it("有効なセッションがある場合はトークンを失効してCookieを削除する", async () => {
      vi.mocked(getCookie).mockReturnValue("encrypted-session-cookie");
      vi.mocked(parseSession).mockResolvedValue({
        session_id: "sid-1",
        access_token: "at-1",
        refresh_token: "rt-1",
        user: { id: "u1", email: "e@e.com", name: "N", role: "user" },
      });
      vi.mocked(revokeTokenAtIdp).mockResolvedValue(undefined);

      const app = createTestApp();
      const res = await makeRequest(app, "/auth/logout", { method: "POST" });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
      expect(vi.mocked(revokeTokenAtIdp)).toHaveBeenCalledOnce();
      expect(vi.mocked(revokeTokenAtIdp).mock.calls[0][1]).toBe("rt-1");
      expect(vi.mocked(revokeTokenAtIdp).mock.calls[0][2]).toBe("sid-1");
      expect(vi.mocked(deleteCookie)).toHaveBeenCalledOnce();
      expect(vi.mocked(deleteCookie).mock.calls[0][1]).toBe("__Host-session");
    });

    it("セッションがない場合はCookie削除のみ行う", async () => {
      vi.mocked(getCookie).mockReturnValue(undefined);
      vi.mocked(parseSession).mockResolvedValue(null);

      const app = createTestApp();
      const res = await makeRequest(app, "/auth/logout", { method: "POST" });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
      expect(vi.mocked(revokeTokenAtIdp)).not.toHaveBeenCalled();
      expect(vi.mocked(deleteCookie)).toHaveBeenCalledOnce();
    });

    it("トークン失効が失敗してもCookie削除は行う", async () => {
      vi.mocked(getCookie).mockReturnValue("encrypted-session-cookie");
      vi.mocked(parseSession).mockResolvedValue({
        session_id: "sid-1",
        access_token: "at-1",
        refresh_token: "rt-1",
        user: { id: "u1", email: "e@e.com", name: "N", role: "user" },
      });
      vi.mocked(revokeTokenAtIdp).mockRejectedValue(new Error("network error"));

      const app = createTestApp();
      const res = await makeRequest(app, "/auth/logout", { method: "POST" });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
      expect(vi.mocked(deleteCookie)).toHaveBeenCalledOnce();
    });
  });
});
