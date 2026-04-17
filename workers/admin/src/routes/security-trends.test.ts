import { describe, it, expect, vi } from "vite-plus/test";
import { encodeSession } from "@0g0-id/shared";
import { Hono } from "hono";

import securityTrendsRoutes from "./security-trends";

const SESSION_COOKIE = "__Host-admin-session";
const baseUrl = "https://admin.0g0.xyz";

async function makeSessionCookie(role: "admin" | "user" = "admin"): Promise<string> {
  const session = {
    session_id: "00000000-0000-0000-0000-000000000000",
    access_token: "mock-access-token",
    refresh_token: "mock-refresh-token",
    user: { id: "admin-user-id", email: "admin@example.com", name: "Admin", role },
  };
  return encodeSession(session, "test-secret");
}

function buildApp(idpFetch: (req: Request) => Promise<Response>) {
  const app = new Hono<{
    Bindings: { IDP: { fetch: typeof idpFetch }; IDP_ORIGIN: string; SESSION_SECRET: string };
  }>();
  app.route("/api/security-trends", securityTrendsRoutes);
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

describe("admin BFF — /api/security-trends", () => {
  describe("GET /ip-stats — IPアドレス別ログイン統計", () => {
    const mockIpStats = [
      { ip_address: "203.0.113.1", country: "JP", login_count: 10, unique_user_count: 3 },
    ];

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/security-trends/ip-stats");
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPへプロキシして統計を返す", async () => {
      const idpFetch = mockIdp(200, { data: mockIpStats, meta: { days: 7, limit: 20 } });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/security-trends/ip-stats?days=7&limit=20", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockIpStats }>();
      expect(body.data).toEqual(mockIpStats);

      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.pathname).toBe("/api/metrics/ip-stats");
      expect(calledUrl.searchParams.get("days")).toBe("7");
      expect(calledUrl.searchParams.get("limit")).toBe("20");
    });

    it("不正なlimit（abc）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/security-trends/ip-stats?limit=abc", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("limit=101（範囲外）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/security-trends/ip-stats?limit=101", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });
  });

  describe("GET /user-agent-stats — User-Agent別ログイン統計", () => {
    const mockUaStats = [{ user_agent: "Mozilla/5.0", login_count: 42, unique_user_count: 7 }];

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/security-trends/user-agent-stats");
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPへプロキシして統計を返す", async () => {
      const idpFetch = mockIdp(200, { data: mockUaStats, meta: { days: 7, limit: 20 } });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/security-trends/user-agent-stats?days=7&limit=20", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockUaStats }>();
      expect(body.data).toEqual(mockUaStats);

      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.pathname).toBe("/api/metrics/user-agent-stats");
      expect(calledUrl.searchParams.get("days")).toBe("7");
      expect(calledUrl.searchParams.get("limit")).toBe("20");
    });

    it("不正なdays（abc）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/security-trends/user-agent-stats?days=abc", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("days=366（範囲外、maxDays=365）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/security-trends/user-agent-stats?days=366", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });
  });

  describe("GET /recent-events — 直近ログインイベント一覧", () => {
    const mockEvents = [
      {
        id: "evt-1",
        user_id: "user-1",
        email: "user@example.com",
        ip_address: "203.0.113.1",
        country: "JP",
        user_agent: "Mozilla/5.0",
        created_at: "2024-01-01T00:00:00Z",
      },
    ];

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/security-trends/recent-events");
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPへプロキシしてイベント一覧を返す", async () => {
      const idpFetch = mockIdp(200, {
        data: mockEvents,
        meta: { limit: 50, offset: 0, total: 1 },
      });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/security-trends/recent-events?limit=50&offset=0", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockEvents }>();
      expect(body.data).toEqual(mockEvents);

      const calledUrl = new URL(vi.mocked(idpFetch).mock.calls[0][0].url);
      expect(calledUrl.pathname).toBe("/api/metrics/recent-events");
      expect(calledUrl.searchParams.get("limit")).toBe("50");
      expect(calledUrl.searchParams.get("offset")).toBe("0");
    });

    it("不正なoffset（負の値）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      // 正規表現 /^\d+$/ で負数は非整数扱い → 400
      const res = await app.request("/api/security-trends/recent-events?offset=-1", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("不正なlimit（abc）で400を返す（IdP呼び出しなし）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);
      const res = await app.request("/api/security-trends/recent-events?limit=abc", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_PARAMETER");
      expect(idpFetch).not.toHaveBeenCalled();
    });
  });
});
