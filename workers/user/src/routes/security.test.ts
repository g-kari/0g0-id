import { describe, it, expect, vi } from "vite-plus/test";
import { encodeSession } from "@0g0-id/shared";
import { Hono } from "hono";

import securityRoutes from "./security";

const SESSION_COOKIE = "__Host-user-session";
const baseUrl = "https://user.0g0.xyz";

async function makeSessionCookie(): Promise<string> {
  const session = {
    access_token: "mock-access-token",
    refresh_token: "mock-refresh-token",
    user: { id: "user-123", email: "user@example.com", name: "Test User", role: "user" as const },
  };
  return encodeSession(session, "test-secret");
}

function buildApp(idpFetch: (req: Request) => Promise<Response>) {
  const app = new Hono<{
    Bindings: { IDP: { fetch: typeof idpFetch }; IDP_ORIGIN: string; SESSION_SECRET: string };
  }>();
  app.route("/api/me/security", securityRoutes);
  return {
    request: (path: string, init?: RequestInit) => {
      const req = new Request(`${baseUrl}${path}`, init);
      return app.request(req, undefined, {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: "test-secret",
      });
    },
  };
}

function mockIdp(status: number, body: unknown): (req: Request) => Promise<Response> {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const mockSecuritySummary = {
  data: {
    active_sessions_count: 2,
    connected_services_count: 1,
    linked_providers: ["google", "github"],
    last_login: {
      provider: "google",
      ip_address: "127.0.0.1",
      created_at: "2024-01-01T00:00:00Z",
    },
  },
};

const mockLoginStats = {
  data: [
    { provider: "google", count: 10 },
    { provider: "github", count: 3 },
  ],
  days: 30,
};

describe("user BFF — /api/me/security", () => {
  describe("GET /summary — セキュリティ概要取得", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/security/summary");

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションありでIdPへプロキシしてセキュリティ概要を返す", async () => {
      const idpFetch = mockIdp(200, mockSecuritySummary);
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/security/summary", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<typeof mockSecuritySummary>();
      expect(body.data.active_sessions_count).toBe(2);
      expect(body.data.linked_providers).toContain("google");
    });

    it("IdPの /api/users/me/security-summary エンドポイントを呼び出す", async () => {
      const idpFetch = mockIdp(200, mockSecuritySummary);
      const app = buildApp(idpFetch);

      await app.request("/api/me/security/summary", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe("https://id.0g0.xyz/api/users/me/security-summary");
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("IdPが500を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR" } });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/security/summary", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /login-stats — ログイン統計取得", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/security/login-stats");

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションありでIdPへプロキシしてログイン統計を返す", async () => {
      const idpFetch = mockIdp(200, mockLoginStats);
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/security/login-stats", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<typeof mockLoginStats>();
      expect(body.data).toHaveLength(2);
      expect(body.days).toBe(30);
    });

    it("IdPの /api/users/me/login-stats エンドポイントを呼び出す", async () => {
      const idpFetch = mockIdp(200, mockLoginStats);
      const app = buildApp(idpFetch);

      await app.request("/api/me/security/login-stats", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).pathname).toBe("/api/users/me/login-stats");
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("daysクエリパラメータをIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { ...mockLoginStats, days: 7 });
      const app = buildApp(idpFetch);

      await app.request("/api/me/security/login-stats?days=7", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get("days")).toBe("7");
    });

    it("daysパラメータなしの場合はURLに余分なパラメータを含まない", async () => {
      const idpFetch = mockIdp(200, mockLoginStats);
      const app = buildApp(idpFetch);

      await app.request("/api/me/security/login-stats", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.has("days")).toBe(false);
    });

    it("IdPが400を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(400, {
        error: { code: "BAD_REQUEST", message: "days は1〜365の整数で指定してください" },
      });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/security/login-stats?days=999", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(400);
    });

    it("days=100はBFFで拒否されずIdPに転送する（maxDays=365）", async () => {
      const idpFetch = mockIdp(200, { ...mockLoginStats, days: 100 });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/security/login-stats?days=100", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).searchParams.get("days")).toBe("100");
    });

    it("days=366はBFFで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/security/login-stats?days=366", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });
  });

  describe("GET /login-trends — ログイントレンド取得", () => {
    const mockLoginTrends = {
      data: [
        { date: "2024-01-01", count: 5 },
        { date: "2024-01-02", count: 3 },
      ],
      days: 30,
    };

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/security/login-trends");

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションありでIdPへプロキシしてログイントレンドを返す", async () => {
      const idpFetch = mockIdp(200, mockLoginTrends);
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/security/login-trends", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<typeof mockLoginTrends>();
      expect(body.data).toHaveLength(2);
      expect(body.days).toBe(30);
    });

    it("IdPの /api/users/me/login-trends エンドポイントを呼び出す", async () => {
      const idpFetch = mockIdp(200, mockLoginTrends);
      const app = buildApp(idpFetch);

      await app.request("/api/me/security/login-trends", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).pathname).toBe("/api/users/me/login-trends");
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("daysクエリパラメータをIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { ...mockLoginTrends, days: 14 });
      const app = buildApp(idpFetch);

      await app.request("/api/me/security/login-trends?days=14", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).searchParams.get("days")).toBe("14");
    });

    it("daysパラメータなしの場合はURLに余分なパラメータを含まない", async () => {
      const idpFetch = mockIdp(200, mockLoginTrends);
      const app = buildApp(idpFetch);

      await app.request("/api/me/security/login-trends", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).searchParams.has("days")).toBe(false);
    });

    it("days=100はBFFで拒否されずIdPに転送する（maxDays=365）", async () => {
      const idpFetch = mockIdp(200, { ...mockLoginTrends, days: 100 });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/security/login-trends?days=100", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).searchParams.get("days")).toBe("100");
    });

    it("days=366はBFFで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/security/login-trends?days=366", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });
  });
});
