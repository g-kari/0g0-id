import { describe, it, expect, vi } from "vite-plus/test";
import { encodeSession } from "@0g0-id/shared";
import { Hono } from "hono";

import servicesRoutes from "./services";

const SESSION_COOKIE = "__Host-admin-session";
const baseUrl = "https://admin.0g0.xyz";

// 管理者セッションCookieを生成するヘルパー
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
  app.route("/api/services", servicesRoutes);
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

// IDP がレスポンスを返すモック
function mockIdp(status: number, body: unknown): (req: Request) => Promise<Response> {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const VALID_SERVICE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const VALID_USER_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const VALID_URI_ID = "c3d4e5f6-a7b8-9012-cdef-123456789012";
const NONEXISTENT_ID = "00000000-0000-0000-0000-000000000000";

const mockServiceList = [
  {
    id: VALID_SERVICE_ID,
    name: "Test Service",
    client_id: "client-abc",
    allowed_scopes: ["profile", "email"],
    owner_user_id: "admin-user-id",
    created_at: "2024-01-01T00:00:00Z",
  },
];

describe("admin BFF — /api/services", () => {
  describe("GET / — サービス一覧", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/services");
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPへプロキシしてサービス一覧を返す", async () => {
      const idpFetch = mockIdp(200, { data: mockServiceList });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/services", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockServiceList }>();
      expect(body.data).toHaveLength(1);
      expect(idpFetch).toHaveBeenCalledOnce();

      // IdP への呼び出しURLを確認
      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe("https://id.0g0.xyz/api/services");
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("IdPが500を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR" } });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/services", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(500);
    });

    it("デフォルトのページネーションではクエリパラメータなしでIdPにリクエストする", async () => {
      const idpFetch = mockIdp(200, { data: mockServiceList });
      const app = buildApp(idpFetch);

      await app.request("/api/services", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.has("limit")).toBe(false);
      expect(url.searchParams.has("offset")).toBe(false);
      expect(url.searchParams.has("name")).toBe(false);
    });

    it("指定したlimit/offsetをIdPのURLに転送する", async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      await app.request("/api/services?limit=10&offset=20", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("offset")).toBe("20");
    });

    it("nameフィルターをIdPのURLに転送する", async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      await app.request("/api/services?name=test", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get("name")).toBe("test");
    });
  });

  describe("GET /:id — サービス取得", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}`);
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにGETしてサービスを返す", async () => {
      const mockService = { id: VALID_SERVICE_ID, name: "Test Service", client_id: "client-abc" };
      const idpFetch = mockIdp(200, { data: mockService });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockService }>();
      expect(body.data.id).toBe(VALID_SERVICE_ID);

      const fetchedReq = vi.mocked(idpFetch).mock.calls[0]?.[0] as Request;
      expect(fetchedReq.url).toBe(`https://id.0g0.xyz/api/services/${VALID_SERVICE_ID}`);
      expect(fetchedReq.method).toBe("GET");
    });

    it("IdPが404を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND", message: "Service not found" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${NONEXISTENT_ID}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST / — サービス作成", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Service" }),
      });

      expect(res.status).toBe(401);
    });

    it("不正なJSONで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/services", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: "invalid-json",
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("管理者セッションでIdPにPOSTしてサービスを作成する", async () => {
      const created = { id: "new-svc", name: "New Service", client_secret: "secret-xxx" };
      const idpFetch = mockIdp(201, { data: created });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/services", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ name: "New Service" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json<{ data: typeof created }>();
      expect(body.data.name).toBe("New Service");

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("POST");
      expect(calledReq.url).toBe("https://id.0g0.xyz/api/services");
    });
  });

  describe("PATCH /:id — スコープ更新", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowed_scopes: ["profile"] }),
      });

      expect(res.status).toBe(401);
    });

    it("不正なJSONで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: "not-json",
      });

      expect(res.status).toBe(400);
    });

    it("管理者セッションでIdPにPATCHしてスコープを更新する", async () => {
      const idpFetch = mockIdp(200, {
        data: { id: VALID_SERVICE_ID, allowed_scopes: ["profile"] },
      });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ allowed_scopes: ["profile"] }),
      });

      expect(res.status).toBe(200);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("PATCH");
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/services/${VALID_SERVICE_ID}`);
    });
  });

  describe("DELETE /:id — サービス削除", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}`, { method: "DELETE" });
      expect(res.status).toBe(401);
    });

    it("管理者セッションでIdPにDELETEしてサービスを削除する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("DELETE");
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/services/${VALID_SERVICE_ID}`);
    });
  });

  describe("GET /:id/redirect-uris — リダイレクトURI一覧", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/redirect-uris`);
      expect(res.status).toBe(401);
    });

    it("管理者セッションでIdPにGETしてリダイレクトURIを返す", async () => {
      const uris = [{ id: "uri-1", uri: "https://app.example.com/callback" }];
      const idpFetch = mockIdp(200, { data: uris });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/redirect-uris`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof uris }>();
      expect(body.data).toHaveLength(1);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(
        `https://id.0g0.xyz/api/services/${VALID_SERVICE_ID}/redirect-uris`,
      );
    });
  });

  describe("POST /:id/redirect-uris — リダイレクトURI追加", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/redirect-uris`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: "https://app.example.com/callback" }),
      });
      expect(res.status).toBe(401);
    });

    it("不正なJSONで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/redirect-uris`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: "bad-json",
      });

      expect(res.status).toBe(400);
    });

    it("管理者セッションでIdPにPOSTしてURIを追加する", async () => {
      const idpFetch = mockIdp(201, { data: { id: "uri-2", uri: "https://app.example.com/cb" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/redirect-uris`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ uri: "https://app.example.com/cb" }),
      });

      expect(res.status).toBe(201);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("POST");
      expect(calledReq.url).toBe(
        `https://id.0g0.xyz/api/services/${VALID_SERVICE_ID}/redirect-uris`,
      );
    });
  });

  describe("POST /:id/rotate-secret — client_secret再発行", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/rotate-secret`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにPOSTして新しいsecretを返す", async () => {
      const rotated = {
        id: VALID_SERVICE_ID,
        client_id: "client-abc",
        client_secret: "new-secret-xyz",
        updated_at: "2024-06-01T00:00:00Z",
      };
      const idpFetch = mockIdp(200, { data: rotated });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/rotate-secret`, {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof rotated }>();
      expect(body.data.client_secret).toBe("new-secret-xyz");

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("POST");
      expect(calledReq.url).toBe(
        `https://id.0g0.xyz/api/services/${VALID_SERVICE_ID}/rotate-secret`,
      );
    });

    it("IdPが404を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${NONEXISTENT_ID}/rotate-secret`, {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /:id/owner — サービス所有権転送", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/owner`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_owner_user_id: VALID_USER_ID }),
      });

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("不正なJSONで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/owner`, {
        method: "PATCH",
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

    it("管理者セッションでIdPにPATCHして所有権を転送する", async () => {
      const updated = {
        id: VALID_SERVICE_ID,
        name: "Test Service",
        client_id: "client-abc",
        owner_user_id: VALID_USER_ID,
        updated_at: "2024-06-01T00:00:00Z",
      };
      const idpFetch = mockIdp(200, { data: updated });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/owner`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ new_owner_user_id: VALID_USER_ID }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof updated }>();
      expect(body.data.owner_user_id).toBe(VALID_USER_ID);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("PATCH");
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/services/${VALID_SERVICE_ID}/owner`);
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
      expect(calledReq.headers.get("Origin")).toBe("https://id.0g0.xyz");
    });

    it("IdPが404を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${NONEXISTENT_ID}/owner`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ new_owner_user_id: VALID_USER_ID }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:id/redirect-uris/:uriId — リダイレクトURI削除", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(
        `/api/services/${VALID_SERVICE_ID}/redirect-uris/${VALID_URI_ID}`,
        {
          method: "DELETE",
        },
      );
      expect(res.status).toBe(401);
    });

    it("管理者セッションでIdPにDELETEしてURIを削除する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request(
        `/api/services/${VALID_SERVICE_ID}/redirect-uris/${VALID_URI_ID}`,
        {
          method: "DELETE",
          headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
        },
      );

      expect(res.status).toBe(204);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("DELETE");
      expect(calledReq.url).toBe(
        `https://id.0g0.xyz/api/services/${VALID_SERVICE_ID}/redirect-uris/${VALID_URI_ID}`,
      );
    });
  });

  describe("GET /:id/users — 認可済みユーザー一覧", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/users`);
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにGETして認可済みユーザー一覧を返す", async () => {
      const mockUsers = [{ id: VALID_USER_ID, email: "user@example.com", name: "User One" }];
      const idpFetch = mockIdp(200, { data: mockUsers, total: 1 });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/users`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockUsers; total: number }>();
      expect(body.data).toHaveLength(1);
    });

    it("デフォルトのlimit=50/offset=0をIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request(`/api/services/${VALID_SERVICE_ID}/users`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get("limit")).toBe("50");
      expect(url.searchParams.get("offset")).toBe("0");
    });

    it("指定したlimit/offsetをIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request(`/api/services/${VALID_SERVICE_ID}/users?limit=10&offset=20`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("offset")).toBe("20");
      expect(url.pathname).toBe(`/api/services/${VALID_SERVICE_ID}/users`);
    });

    it("IdPが404を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${NONEXISTENT_ID}/users`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:id/users/:userId — ユーザーのサービスアクセス失効", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/users/${VALID_USER_ID}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにDELETEしてアクセスを失効する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/users/${VALID_USER_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("DELETE");
      expect(calledReq.url).toBe(
        `https://id.0g0.xyz/api/services/${VALID_SERVICE_ID}/users/${VALID_USER_ID}`,
      );
    });

    it("サービスIDとユーザーIDをIdPのURLに正しく含める", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request(`/api/services/${VALID_SERVICE_ID}/users/${VALID_USER_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(
        `https://id.0g0.xyz/api/services/${VALID_SERVICE_ID}/users/${VALID_USER_ID}`,
      );
    });

    it("Originヘッダーを付与してIdPに送信する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request(`/api/services/${VALID_SERVICE_ID}/users/${VALID_USER_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get("Origin")).toBe("https://id.0g0.xyz");
    });

    it("IdPが404を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/users/${NONEXISTENT_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("パスパラメータバリデーション", () => {
    it("不正なサービスID形式で400を返す（GET /:id）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/services/not-a-uuid", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Invalid service ID format");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("不正なサービスID形式で400を返す（GET /:id/redirect-uris）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/services/invalid!/redirect-uris", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("不正なユーザーID形式で400を返す（DELETE /:id/users/:userId）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/users/not-a-uuid`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Invalid user ID format");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("不正なURI ID形式で400を返す（DELETE /:id/redirect-uris/:uriId）", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/services/${VALID_SERVICE_ID}/redirect-uris/not-a-uuid`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Invalid URI ID format");
      expect(idpFetch).not.toHaveBeenCalled();
    });
  });
});
