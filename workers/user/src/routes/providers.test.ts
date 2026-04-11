import { describe, it, expect, vi } from "vite-plus/test";
import { encodeSession } from "@0g0-id/shared";
import { Hono } from "hono";

import providersRoutes from "./providers";

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
  app.route("/api/providers", providersRoutes);
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

const mockProviders = {
  data: {
    google: { connected: true },
    line: { connected: false },
    twitch: { connected: false },
    github: { connected: true },
    x: { connected: false },
  },
};

describe("user BFF — /api/providers", () => {
  describe("GET / — 連携済みプロバイダー一覧", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/providers");

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションありでIdPへプロキシしてプロバイダー一覧を返す", async () => {
      const idpFetch = mockIdp(200, mockProviders);
      const app = buildApp(idpFetch);

      const res = await app.request("/api/providers", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<typeof mockProviders>();
      expect(body.data.google.connected).toBe(true);
      expect(body.data.github.connected).toBe(true);
    });

    it("IdPの /api/users/me/providers エンドポイントを呼び出す", async () => {
      const idpFetch = mockIdp(200, mockProviders);
      const app = buildApp(idpFetch);

      await app.request("/api/providers", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe("https://id.0g0.xyz/api/users/me/providers");
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("IdPが500を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR" } });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/providers", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /:provider — プロバイダー連携解除", () => {
    it("無効なプロバイダー名で400を返す（IdP未呼び出し）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/providers/facebook", { method: "DELETE" });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("空文字列のプロバイダー名で400を返す（IdP未呼び出し）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/providers/Twitter", { method: "DELETE" });

      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/providers/github", { method: "DELETE" });

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションありでIdPにDELETEしてプロバイダーを解除する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request("/api/providers/github", {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("DELETE");
      expect(calledReq.url).toBe("https://id.0g0.xyz/api/users/me/providers/github");
    });

    it("プロバイダー名をIdPのURLに正しく含める", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      for (const provider of ["google", "line", "twitch", "github", "x"]) {
        const res = await app.request(`/api/providers/${provider}`, {
          method: "DELETE",
          headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
        });
        expect(res.status).toBe(204);

        const calls = (idpFetch as ReturnType<typeof vi.fn>).mock.calls;
        const lastCall = calls[calls.length - 1] as [Request];
        expect(lastCall[0].url).toBe(`https://id.0g0.xyz/api/users/me/providers/${provider}`);
      }
    });

    it("Originヘッダーを付与してIdPに送信する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request("/api/providers/google", {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get("Origin")).toBe("https://id.0g0.xyz");
    });

    it("最後のプロバイダーを解除しようとすると409を返す", async () => {
      const idpFetch = mockIdp(409, { error: { code: "LAST_PROVIDER" } });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/providers/google", {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(409);
    });

    it("未連携プロバイダーを解除しようとすると404を返す", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/providers/twitch", {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });
});
