import { describe, it, expect, vi } from "vite-plus/test";
import { encodeSession } from "@0g0-id/shared";
import { Hono } from "hono";

import bffSessionsRoutes from "./bff-sessions";

const SESSION_COOKIE = "__Host-user-session";
const baseUrl = "https://user.0g0.xyz";

async function makeSessionCookie(): Promise<string> {
  const session = {
    session_id: "00000000-0000-0000-0000-000000000000",
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
  app.route("/api/me/bff-sessions", bffSessionsRoutes);
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

describe("user BFF — /api/me/bff-sessions", () => {
  describe("GET / — BFFセッション一覧", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/bff-sessions");

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションありでIdPへGETしてBFFセッション一覧を返す", async () => {
      const mockSessions = [
        {
          id: "bff-session-1",
          user_id: "user-123",
          created_at: 1700000000,
          expires_at: 1800000000,
          user_agent: "Mozilla/5.0",
          ip: "192.0.2.1",
          bff_origin: "https://user.0g0.xyz",
          has_device_key: true,
          device_bound_at: 1700000001,
        },
        {
          id: "bff-session-2",
          user_id: "user-123",
          created_at: 1700000000,
          expires_at: 1800000000,
          user_agent: "Mozilla/5.0",
          ip: "192.0.2.2",
          bff_origin: "https://user.0g0.xyz",
          has_device_key: false,
          device_bound_at: null,
        },
      ];
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: mockSessions }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/bff-sessions", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: unknown[] }>();
      expect(body.data).toHaveLength(2);
    });

    it("IdPの /api/users/me/bff-sessions エンドポイントをGETで呼び出す", async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      await app.request("/api/me/bff-sessions", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("GET");
      expect(calledReq.url).toBe("https://id.0g0.xyz/api/users/me/bff-sessions");
    });

    it("AuthorizationヘッダーにアクセストークンをBearerで付与する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      await app.request("/api/me/bff-sessions", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("IdPが500を返した場合はそのまま伝播する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/bff-sessions", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /:sessionId — 自分のBFFセッションを失効（self-service）", () => {
    const currentSessionId = "00000000-0000-0000-0000-000000000000";
    const otherSessionId = "00000000-0000-0000-0000-0000000000aa";

    it("Cookieなし → 401（IdPは呼ばない）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/me/bff-sessions/${currentSessionId}`, {
        method: "DELETE",
      });

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("非UUID形式の sessionId → 400（IdPは呼ばない）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/me/bff-sessions/not-a-uuid", {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("IdP 204 + 現セッションと一致 → 204 + Set-Cookie に削除指示", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/me/bff-sessions/${currentSessionId}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);
      const setCookie = res.headers.get("Set-Cookie");
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain(SESSION_COOKIE);
      // deleteCookie は Max-Age=0 を付与する
      expect(setCookie).toMatch(/Max-Age=0/);
    });

    it("IdP 204 + 他端末セッション失効 → 204 + Cookie 削除なし", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/me/bff-sessions/${otherSessionId}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    });

    it("IdP 404 → 404 をプロキシ（Cookie 削除なし）", async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/me/bff-sessions/${currentSessionId}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    });

    it("IdP 403 → 403 をプロキシ（Cookie 削除なし）", async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "FORBIDDEN" } }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/me/bff-sessions/${currentSessionId}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(403);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    });

    it("IdP の DELETE /api/users/me/bff-sessions/${id} を呼び出す", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request(`/api/me/bff-sessions/${otherSessionId}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("DELETE");
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/me/bff-sessions/${otherSessionId}`);
      expect(calledReq.headers.get("Origin")).toBe("https://id.0g0.xyz");
    });
  });
});
