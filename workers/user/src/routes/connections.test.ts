import { describe, it, expect, vi } from "vite-plus/test";
import { encodeSession } from "@0g0-id/shared";
import { Hono } from "hono";

import connectionsRoutes from "./connections";

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
  app.route("/api/connections", connectionsRoutes);
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

const mockConnections = [
  { service_id: "service-1", service_name: "My App", connected_at: "2024-01-01T00:00:00Z" },
  { service_id: "service-2", service_name: "Another App", connected_at: "2024-01-02T00:00:00Z" },
];

describe("user BFF — /api/connections", () => {
  describe("GET / — 連携済みサービス一覧", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/connections");

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションありでIdPへプロキシして連携サービス一覧を返す", async () => {
      const idpFetch = mockIdp(200, { data: mockConnections });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/connections", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockConnections }>();
      expect(body.data).toHaveLength(2);
    });

    it("IdPの /api/users/me/connections エンドポイントを呼び出す", async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      await app.request("/api/connections", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe("https://id.0g0.xyz/api/users/me/connections");
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("IdPが500を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR" } });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/connections", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /:serviceId — サービス連携解除", () => {
    const validServiceId = "550e8400-e29b-41d4-a716-446655440000";

    it("不正なserviceId形式で400を返す（IdP未呼び出し）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/connections/not-a-uuid", { method: "DELETE" });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("UUID風だが不正な形式のserviceIdで400を返す（IdP未呼び出し）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/connections/550e8400-e29b-41d4-a716-ZZZZZZZZZZZZ", {
        method: "DELETE",
      });

      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/connections/${validServiceId}`, { method: "DELETE" });

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションありでIdPにDELETEして連携を解除する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/connections/${validServiceId}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("DELETE");
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/me/connections/${validServiceId}`);
    });

    it("serviceIdをIdPのURLに正しく含める", async () => {
      const otherId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request(`/api/connections/${otherId}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/me/connections/${otherId}`);
    });

    it("Originヘッダーを付与してIdPに送信する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request(`/api/connections/${validServiceId}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get("Origin")).toBe("https://id.0g0.xyz");
    });

    it("存在しない連携を解除しようとすると404を返す", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/connections/${validServiceId}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });

    it("Authorizationヘッダーにセッションのアクセストークンを付与する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request(`/api/connections/${validServiceId}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });
  });
});
