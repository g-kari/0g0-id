import { describe, it, expect, vi } from "vite-plus/test";
import { encodeSession } from "@0g0-id/shared";
import { Hono } from "hono";

import deviceRoutes from "./device";

const SESSION_COOKIE = "__Host-user-session";
const baseUrl = "https://user.0g0.xyz";

async function makeSessionCookie(userId = "user-123"): Promise<string> {
  const session = {
    access_token: "mock-access-token",
    refresh_token: "mock-refresh-token",
    user: { id: userId, email: "user@example.com", name: "Test User", role: "user" as const },
  };
  return encodeSession(session, "test-secret");
}

function buildApp(idpFetch: (req: Request) => Promise<Response>) {
  const app = new Hono<{
    Bindings: {
      IDP: { fetch: typeof idpFetch };
      IDP_ORIGIN: string;
      SESSION_SECRET: string;
      INTERNAL_SERVICE_SECRET?: string;
    };
  }>();
  app.route("/api/device", deviceRoutes);
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

describe("user BFF — /api/device", () => {
  describe("POST /verify — ユーザーコード検証", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_code: "ABCD-EFGH" }),
      });

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("不正なリクエストボディで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: "not-json",
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("user_code が欠けている場合に400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("小文字のuser_codeは大文字に変換して受け付ける（toUpperCase）", async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ user_code: "abcd-efgh" }),
      });

      // toUpperCase() で変換されるので有効な形式として通過する
      expect(res.status).toBe(200);
      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const sentBody = await calledReq.json<{ user_code: string }>();
      expect(sentBody.user_code).toBe("ABCD-EFGH");
    });

    it.each([
      "ABCD-EFG", // 短すぎる
      "ABCD-EFGHI", // 長すぎる
      "ABCDEFGH", // ハイフンなし
      "ABCD_EFGH", // アンダースコア
    ])('不正な形式のuser_code "%s" で400を返す', async (invalidCode) => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ user_code: invalidCode }),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("IdP到達不能時に502を返す", async () => {
      const idpFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ user_code: "ABCD-EFGH" }),
      });

      expect(res.status).toBe(502);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("UPSTREAM_ERROR");
    });

    it("有効なuser_codeでIdPにリクエストを転送してレスポンスを返す", async () => {
      const idpResponse = {
        data: { service_name: "Test Service", scopes: ["profile", "email"] },
      };
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(idpResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ user_code: "ABCD-EFGH" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<typeof idpResponse>();
      expect(body.data.service_name).toBe("Test Service");

      // IdPへのリクエスト内容を確認
      expect(idpFetch).toHaveBeenCalledTimes(1);
      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("POST");
      expect(calledReq.url).toBe("https://id.0g0.xyz/api/device/verify");
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("IdPのuser_codeをそのままの大文字形式で転送する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      await app.request("/api/device/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ user_code: "ABCD-EFGH" }),
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const sentBody = await calledReq.json<{ user_code: string }>();
      expect(sentBody.user_code).toBe("ABCD-EFGH");
    });

    it("IdPが404を返した場合はそのステータスコードをそのまま返す", async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "INVALID_CODE", message: "Unknown user code" } }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ user_code: "ABCD-EFGH" }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /approve — デバイス承認/拒否", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_code: "ABCD-EFGH", action: "approve" }),
      });

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("不正なリクエストボディで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: "not-json",
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("不正な形式のuser_codeで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ user_code: "invalid", action: "approve" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it.each(["approve", "deny"] as const)('無効なaction "%s" 以外のactionで400を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ user_code: "ABCD-EFGH", action: "invalid-action" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it('actionが "approve" でない場合に400を返す', async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      for (const badAction of ["APPROVE", "Accept", "yes", ""]) {
        const res = await app.request("/api/device/approve", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
          },
          body: JSON.stringify({ user_code: "ABCD-EFGH", action: badAction }),
        });
        expect(res.status).toBe(400);
      }
    });

    it("IdP到達不能時に502を返す", async () => {
      const idpFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ user_code: "ABCD-EFGH", action: "approve" }),
      });

      expect(res.status).toBe(502);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("UPSTREAM_ERROR");
    });

    it("approve アクションでIdPにリクエストを転送してレスポンスを返す", async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "approved" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ user_code: "ABCD-EFGH", action: "approve" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ status: string }>();
      expect(body.status).toBe("approved");

      // IdPへのリクエスト内容を確認
      expect(idpFetch).toHaveBeenCalledTimes(1);
      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("POST");
      expect(calledReq.url).toBe("https://id.0g0.xyz/api/device/verify");
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");

      const sentBody = await calledReq.json<{ user_code: string; action: string }>();
      expect(sentBody.user_code).toBe("ABCD-EFGH");
      expect(sentBody.action).toBe("approve");
    });

    it("deny アクションでIdPにリクエストを転送してレスポンスを返す", async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "denied" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ user_code: "ABCD-EFGH", action: "deny" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ status: string }>();
      expect(body.status).toBe("denied");

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const sentBody = await calledReq.json<{ user_code: string; action: string }>();
      expect(sentBody.action).toBe("deny");
    });

    it("IdPが400を返した場合はそのステータスコードを返す", async () => {
      const idpFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "CODE_EXPIRED", message: "Device code expired" } }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
      const app = buildApp(idpFetch);

      const res = await app.request("/api/device/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ user_code: "ABCD-EFGH", action: "approve" }),
      });

      expect(res.status).toBe(400);
    });
  });
});
