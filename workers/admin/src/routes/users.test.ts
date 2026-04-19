import { describe, it, expect, vi } from "vite-plus/test";
import { encodeSession } from "@0g0-id/shared";
import { Hono } from "hono";

import usersRoutes from "./users";

const SESSION_COOKIE = "__Host-admin-session";
const baseUrl = "https://admin.0g0.xyz";

// テスト用UUID定数
const USER_ID = "00000000-0000-0000-0000-000000000001";
const TARGET_ID = "00000000-0000-0000-0000-000000000002";
const SPECIFIC_ID_1 = "00000000-0000-0000-0000-000000000003";
const SPECIFIC_ID_2 = "00000000-0000-0000-0000-000000000004";
const SERVICE_OWNER_ID = "00000000-0000-0000-0000-000000000005";
const NO_SERVICES_USER_ID = "00000000-0000-0000-0000-000000000006";
const ADMIN_USER_ID = "00000000-0000-0000-0000-000000000099";
const NOT_FOUND_USER_ID = "00000000-0000-0000-0000-000000000404";
const TOKEN_ID = "00000000-0000-0000-0000-000000000010";
const SPECIFIC_TOKEN_ID = "00000000-0000-0000-0000-000000000011";
const NOT_FOUND_TOKEN_ID = "00000000-0000-0000-0000-000000000410";

// 管理者セッションCookieを生成するヘルパー
async function makeSessionCookie(role: "admin" | "user" = "admin"): Promise<string> {
  const session = {
    session_id: "00000000-0000-0000-0000-000000000000",
    access_token: "mock-access-token",
    refresh_token: "mock-refresh-token",
    user: { id: ADMIN_USER_ID, email: "admin@example.com", name: "Admin", role },
  };
  return encodeSession(session, "test-secret");
}

function buildApp(idpFetch: (req: Request) => Promise<Response>) {
  const app = new Hono<{
    Bindings: { IDP: { fetch: typeof idpFetch }; IDP_ORIGIN: string; SESSION_SECRET: string };
  }>();
  app.route("/api/users", usersRoutes);
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

const mockUserList = [
  {
    id: "user-1",
    email: "user1@example.com",
    name: "User One",
    role: "user",
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "user-2",
    email: "user2@example.com",
    name: "User Two",
    role: "admin",
    created_at: "2024-01-02T00:00:00Z",
  },
];

describe("admin BFF — /api/users", () => {
  describe("GET / — ユーザー一覧", () => {
    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users");
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPへプロキシしてユーザー一覧を返す", async () => {
      const idpFetch = mockIdp(200, { data: mockUserList, total: 2 });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockUserList; total: number }>();
      expect(body.data).toHaveLength(2);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.pathname).toBe("/api/users");
      expect(url.searchParams.get("limit")).toBe("50");
      expect(url.searchParams.get("offset")).toBe("0");
    });

    it("limit/offsetのクエリパラメータをIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users?limit=10&offset=20", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("offset")).toBe("20");
    });

    it("emailクエリパラメータをIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request("/api/users?email=test@example.com", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).searchParams.get("email")).toBe("test@example.com");
    });

    it("roleクエリパラメータをIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request("/api/users?role=admin", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).searchParams.get("role")).toBe("admin");
    });

    it("nameクエリパラメータをIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request("/api/users?name=Alice", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).searchParams.get("name")).toBe("Alice");
    });

    it("bannedクエリパラメータ(true)をIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request("/api/users?banned=true", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).searchParams.get("banned")).toBe("true");
    });

    it("bannedクエリパラメータ(false)をIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request("/api/users?banned=false", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).searchParams.get("banned")).toBe("false");
    });

    it("bannedクエリパラメータが不正な場合はIdPに転送しない", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request("/api/users?banned=maybe", {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).searchParams.has("banned")).toBe(false);
    });
  });

  describe("GET /:id — ユーザー詳細", () => {
    it("非UUID形式のIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users/not-a-uuid");
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}`);
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPへプロキシしてユーザー詳細を返す", async () => {
      const mockUser = { id: "user-1", email: "user1@example.com", name: "User One", role: "user" };
      const idpFetch = mockIdp(200, { data: mockUser });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockUser }>();
      expect(body.data.id).toBe("user-1");

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${USER_ID}`);
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("存在しないIDでIdPが404を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${NOT_FOUND_USER_ID}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /:id/role — ユーザーロール変更", () => {
    it("非UUID形式のIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users/not-a-uuid/role", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });

      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("不正なJSONで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/role`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: "not-valid-json",
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("管理者セッションでIdPにPATCHしてロールを変更する", async () => {
      const idpFetch = mockIdp(200, { data: { id: "user-1", role: "admin" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/role`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ role: "admin" }),
      });

      expect(res.status).toBe(200);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("PATCH");
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${USER_ID}/role`);
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("IDパラメータをIdPのURLに正しく含める", async () => {
      const idpFetch = mockIdp(200, { data: {} });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${TARGET_ID}/role`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ role: "user" }),
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${TARGET_ID}/role`);
    });

    it("IdPが403（自己変更禁止）を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(403, { error: { code: "SELF_ROLE_CHANGE_FORBIDDEN" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${ADMIN_USER_ID}/role`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}`,
        },
        body: JSON.stringify({ role: "user" }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /:id/ban — ユーザー停止", () => {
    it("非UUID形式のIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users/not-a-uuid/ban", { method: "PATCH" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/ban`, { method: "PATCH" });
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにPATCHしてユーザーを停止する", async () => {
      const idpFetch = mockIdp(200, {
        data: { id: "user-1", role: "user", banned_at: "2024-06-01T00:00:00Z" },
      });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/ban`, {
        method: "PATCH",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("PATCH");
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${USER_ID}/ban`);
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("ユーザーIDをIdPのURLに正しく含める", async () => {
      const idpFetch = mockIdp(200, { data: {} });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${TARGET_ID}/ban`, {
        method: "PATCH",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${TARGET_ID}/ban`);
    });

    it("OriginヘッダーをIdPに送信する", async () => {
      const idpFetch = mockIdp(200, { data: {} });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${USER_ID}/ban`, {
        method: "PATCH",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get("Origin")).toBe("https://id.0g0.xyz");
    });

    it("IdPが403（自己停止禁止）を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(403, {
        error: { code: "FORBIDDEN", message: "Cannot ban yourself" },
      });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${ADMIN_USER_ID}/ban`, {
        method: "PATCH",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(403);
    });

    it("IdPが409（既に停止済み）を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(409, {
        error: { code: "CONFLICT", message: "User is already banned" },
      });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/ban`, {
        method: "PATCH",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(409);
    });
  });

  describe("DELETE /:id/ban — ユーザー停止解除", () => {
    it("非UUID形式のIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users/not-a-uuid/ban", { method: "DELETE" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/ban`, { method: "DELETE" });
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにDELETEしてユーザー停止を解除する", async () => {
      const idpFetch = mockIdp(200, { data: { id: "user-1", role: "user", banned_at: null } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/ban`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("DELETE");
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${USER_ID}/ban`);
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("ユーザーIDをIdPのURLに正しく含める", async () => {
      const idpFetch = mockIdp(200, { data: {} });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${TARGET_ID}/ban`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${TARGET_ID}/ban`);
    });

    it("OriginヘッダーをIdPに送信する", async () => {
      const idpFetch = mockIdp(200, { data: {} });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${USER_ID}/ban`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get("Origin")).toBe("https://id.0g0.xyz");
    });

    it("IdPが409（停止されていない）を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(409, { error: { code: "CONFLICT", message: "User is not banned" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/ban`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(409);
    });

    it("IdPが404（ユーザー不在）を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${NOT_FOUND_USER_ID}/ban`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:id — ユーザー削除", () => {
    it("非UUID形式のIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users/not-a-uuid", { method: "DELETE" });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}`, { method: "DELETE" });
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにDELETEしてユーザーを削除する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("DELETE");
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${USER_ID}`);
    });

    it("IDパラメータをIdPのURLに正しく含める", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${SPECIFIC_ID_2}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${SPECIFIC_ID_2}`);
    });

    it("IdPが409（サービス所有者削除不可）を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(409, { error: { code: "USER_OWNS_SERVICES" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${SERVICE_OWNER_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(409);
    });

    it("Originヘッダーを付与してIdPに送信する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${USER_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get("Origin")).toBe("https://id.0g0.xyz");
    });
  });

  describe("GET /:id/services — ユーザー認可サービス一覧", () => {
    it("非UUID形式のIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users/not-a-uuid/services");
      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/services`);
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにGETして認可サービス一覧を返す", async () => {
      const mockConnections = [
        { service_id: "svc-1", service_name: "Service One", authorized_at: "2024-01-01T00:00:00Z" },
        { service_id: "svc-2", service_name: "Service Two", authorized_at: "2024-01-02T00:00:00Z" },
      ];
      const idpFetch = mockIdp(200, { data: mockConnections });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/services`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockConnections }>();
      expect(body.data).toHaveLength(2);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${USER_ID}/services`);
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("ユーザーIDをIdPのURLに正しく含める", async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${SPECIFIC_ID_1}/services`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${SPECIFIC_ID_1}/services`);
    });

    it("IdPが404（ユーザー不在）を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${NOT_FOUND_USER_ID}/services`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });

    it("認可サービスが0件の場合も正常に返す", async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${NO_SERVICES_USER_ID}/services`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: unknown[] }>();
      expect(body.data).toHaveLength(0);
    });
  });

  describe("GET /:id/login-history — ユーザーログイン履歴取得", () => {
    it("非UUID形式のIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users/not-a-uuid/login-history");
      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/login-history`);
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにGETしてログイン履歴を返す", async () => {
      const mockEvents = [
        {
          id: "evt-1",
          user_id: "user-1",
          ip_address: "1.2.3.4",
          created_at: "2024-01-01T00:00:00Z",
        },
      ];
      const idpFetch = mockIdp(200, { data: mockEvents, total: 1 });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/login-history`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockEvents; total: number }>();
      expect(body.data).toHaveLength(1);
    });

    it("デフォルトのlimit=20/offset=0をIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${USER_ID}/login-history`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get("limit")).toBe("20");
      expect(url.searchParams.get("offset")).toBe("0");
      expect(url.pathname).toBe(`/api/users/${USER_ID}/login-history`);
    });

    it("指定したlimit/offsetをIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${USER_ID}/login-history?limit=5&offset=10`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get("limit")).toBe("5");
      expect(url.searchParams.get("offset")).toBe("10");
    });

    it("ユーザーIDをIdPのURLに正しく含める", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${SPECIFIC_ID_2}/login-history`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(new URL(calledReq.url).pathname).toBe(`/api/users/${SPECIFIC_ID_2}/login-history`);
    });

    it("IdPが404を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${NOT_FOUND_USER_ID}/login-history`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });

    it("providerクエリパラメータをIdPに転送する", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${USER_ID}/login-history?provider=google`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.get("provider")).toBe("google");
    });

    it("providerなしのリクエストではproviderパラメータをIdPに送らない", async () => {
      const idpFetch = mockIdp(200, { data: [], total: 0 });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${USER_ID}/login-history`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      const url = new URL(calledReq.url);
      expect(url.searchParams.has("provider")).toBe(false);
    });

    it("不正なproviderで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(
        `/api/users/${USER_ID}/login-history?provider=invalid-provider`,
        {
          headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
        },
      );

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(idpFetch).not.toHaveBeenCalled();
    });
  });

  describe("GET /:id/providers — ユーザーのSNSプロバイダー連携状態", () => {
    it("非UUID形式のIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users/not-a-uuid/providers");
      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/providers`);
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにGETしてプロバイダー連携状態を返す", async () => {
      const mockProviders = [
        { provider: "google", connected: true },
        { provider: "line", connected: false },
        { provider: "twitch", connected: false },
        { provider: "github", connected: true },
        { provider: "x", connected: false },
      ];
      const idpFetch = mockIdp(200, { data: mockProviders });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/providers`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockProviders }>();
      expect(body.data).toHaveLength(5);
      expect(body.data.find((p) => p.provider === "google")?.connected).toBe(true);
      expect(body.data.find((p) => p.provider === "line")?.connected).toBe(false);
    });

    it("ユーザーIDをIdPのURLに正しく含める", async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${SPECIFIC_ID_1}/providers`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${SPECIFIC_ID_1}/providers`);
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("IdPが404（ユーザー不在）を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${NOT_FOUND_USER_ID}/providers`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("GET /:id/owned-services — ユーザー所有サービス一覧", () => {
    it("非UUID形式のIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users/not-a-uuid/owned-services");
      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/owned-services`);
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにGETして所有サービス一覧を返す", async () => {
      const mockServices = [
        {
          id: "service-1",
          name: "My Service",
          client_id: "client-abc",
          allowed_scopes: ["profile", "email"],
          created_at: "2024-01-01T00:00:00Z",
        },
        {
          id: "service-2",
          name: "Another Service",
          client_id: "client-xyz",
          allowed_scopes: ["profile"],
          created_at: "2024-02-01T00:00:00Z",
        },
      ];
      const idpFetch = mockIdp(200, { data: mockServices });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/owned-services`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockServices }>();
      expect(body.data).toHaveLength(2);
      expect(body.data[0]).toMatchObject({ id: "service-1", name: "My Service" });
    });

    it("ユーザーIDをIdPのURLに正しく含める", async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${SPECIFIC_ID_1}/owned-services`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${SPECIFIC_ID_1}/owned-services`);
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("IdPが404（ユーザー不在）を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${NOT_FOUND_USER_ID}/owned-services`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("GET /:id/tokens — ユーザーアクティブセッション一覧", () => {
    it("非UUID形式のIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users/not-a-uuid/tokens");
      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/tokens`);
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにGETしてセッション一覧を返す", async () => {
      const mockSessions = [
        {
          id: "rt-1",
          service_id: null,
          service_name: null,
          created_at: "2024-01-01T00:00:00Z",
          expires_at: "2024-02-01T00:00:00Z",
        },
        {
          id: "rt-2",
          service_id: "svc-1",
          service_name: "My Service",
          created_at: "2024-01-02T00:00:00Z",
          expires_at: "2024-02-02T00:00:00Z",
        },
      ];
      const idpFetch = mockIdp(200, { data: mockSessions });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/tokens`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockSessions }>();
      expect(body.data).toHaveLength(2);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${USER_ID}/tokens`);
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("ユーザーIDをIdPのURLに正しく含める", async () => {
      const idpFetch = mockIdp(200, { data: [] });
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${SPECIFIC_ID_1}/tokens`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${SPECIFIC_ID_1}/tokens`);
    });

    it("IdPが404（ユーザー不在）を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${NOT_FOUND_USER_ID}/tokens`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("GET /:id/bff-sessions — DBSC バインド状態付き BFF セッション一覧", () => {
    it("非UUID形式のIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users/not-a-uuid/bff-sessions");
      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/bff-sessions`);
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPへプロキシし has_device_key を含む一覧を返す", async () => {
      const mockBffSessions = [
        {
          id: "00000000-0000-0000-0000-0000000000aa",
          user_id: USER_ID,
          created_at: 1700000000,
          expires_at: 1800000000,
          user_agent: "Mozilla/5.0",
          ip: "203.0.113.1",
          bff_origin: "https://admin.0g0.xyz",
          has_device_key: true,
          device_bound_at: 1700000100,
        },
      ];
      const idpFetch = mockIdp(200, { data: mockBffSessions });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/bff-sessions`, {
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ data: typeof mockBffSessions }>();
      expect(body.data[0].has_device_key).toBe(true);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${USER_ID}/bff-sessions`);
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });
  });

  describe("DELETE /:id/bff-sessions/:sessionId — 単一 BFF セッション失効", () => {
    const SESSION_ID = "00000000-0000-0000-0000-0000000000aa";

    it("非UUID形式のユーザーIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/not-a-uuid/bff-sessions/${SESSION_ID}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("非UUID形式の sessionId で400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/bff-sessions/not-a-uuid`, {
        method: "DELETE",
      });
      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/bff-sessions/${SESSION_ID}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPへDELETEを伝播し204を返す", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/bff-sessions/${SESSION_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("DELETE");
      expect(calledReq.url).toBe(
        `https://id.0g0.xyz/api/users/${USER_ID}/bff-sessions/${SESSION_ID}`,
      );
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
      expect(calledReq.headers.get("Origin")).toBe("https://id.0g0.xyz");
    });

    it("IdPが404を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/bff-sessions/${SESSION_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:id/tokens — ユーザー全セッション無効化", () => {
    it("非UUID形式のIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request("/api/users/not-a-uuid/tokens", { method: "DELETE" });
      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/tokens`, { method: "DELETE" });
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにDELETEして全セッションを無効化する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/tokens`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("DELETE");
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${USER_ID}/tokens`);
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("ユーザーIDをIdPのURLに正しく含める", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${SPECIFIC_ID_2}/tokens`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${SPECIFIC_ID_2}/tokens`);
    });

    it("Originヘッダーを付与してIdPに送信する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${USER_ID}/tokens`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get("Origin")).toBe("https://id.0g0.xyz");
    });

    it("IdPが404（ユーザー不在）を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${NOT_FOUND_USER_ID}/tokens`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:id/tokens/:tokenId — ユーザー特定セッション失効", () => {
    it("非UUID形式のユーザーIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/not-a-uuid/tokens/${TOKEN_ID}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(400);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("非UUID形式のトークンIDで400を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/tokens/not-a-uuid`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("セッションなしで401を返す", async () => {
      const idpFetch = vi.fn();
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/tokens/${TOKEN_ID}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
      expect(idpFetch).not.toHaveBeenCalled();
    });

    it("管理者セッションでIdPにDELETEして特定セッションを失効させる", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/tokens/${TOKEN_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(204);

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.method).toBe("DELETE");
      expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/${USER_ID}/tokens/${TOKEN_ID}`);
      expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
    });

    it("ユーザーIDとトークンIDをIdPのURLに正しく含める", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${SPECIFIC_ID_1}/tokens/${SPECIFIC_TOKEN_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.url).toBe(
        `https://id.0g0.xyz/api/users/${SPECIFIC_ID_1}/tokens/${SPECIFIC_TOKEN_ID}`,
      );
    });

    it("Originヘッダーを付与してIdPに送信する", async () => {
      const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const app = buildApp(idpFetch);

      await app.request(`/api/users/${USER_ID}/tokens/${TOKEN_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
      expect(calledReq.headers.get("Origin")).toBe("https://id.0g0.xyz");
    });

    it("IdPが404（セッション不在）を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${USER_ID}/tokens/${NOT_FOUND_TOKEN_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });

    it("IdPが404（ユーザー不在）を返した場合はそのまま伝播する", async () => {
      const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
      const app = buildApp(idpFetch);

      const res = await app.request(`/api/users/${NOT_FOUND_USER_ID}/tokens/${TOKEN_ID}`, {
        method: "DELETE",
        headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
      });

      expect(res.status).toBe(404);
    });
  });
});

describe("GET /api/users/:id/login-stats — プロバイダー別ログイン統計", () => {
  const mockStats = [
    { provider: "google", count: 10 },
    { provider: "github", count: 3 },
  ];

  it("非UUID形式のIDで400を返す", async () => {
    const idpFetch = vi.fn();
    const app = buildApp(idpFetch);

    const res = await app.request("/api/users/not-a-uuid/login-stats");
    expect(res.status).toBe(400);
    expect(idpFetch).not.toHaveBeenCalled();
  });

  it("セッションなしで401を返す", async () => {
    const idpFetch = vi.fn();
    const app = buildApp(idpFetch);

    const res = await app.request(`/api/users/${USER_ID}/login-stats`);
    expect(res.status).toBe(401);
    expect(idpFetch).not.toHaveBeenCalled();
  });

  it("管理者セッションでIdPへプロキシして統計を返す", async () => {
    const idpFetch = mockIdp(200, { data: mockStats, days: 30 });
    const app = buildApp(idpFetch);

    const res = await app.request(`/api/users/${USER_ID}/login-stats`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; days: number }>();
    expect(body.data).toHaveLength(2);
    expect(body.days).toBe(30);
  });

  it("daysクエリパラメータをIdPへ転送する", async () => {
    const idpFetch = mockIdp(200, { data: mockStats, days: 7 });
    const app = buildApp(idpFetch);

    await app.request(`/api/users/${USER_ID}/login-stats?days=7`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });

    const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
    expect(new URL(calledReq.url).searchParams.get("days")).toBe("7");
  });

  it("IdPが404を返した場合はそのまま伝播する", async () => {
    const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
    const app = buildApp(idpFetch);

    const res = await app.request(`/api/users/${NOT_FOUND_USER_ID}/login-stats`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });

    expect(res.status).toBe(404);
  });

  it("不正なdaysで400を返す", async () => {
    const idpFetch = vi.fn();
    const app = buildApp(idpFetch);

    const res = await app.request(`/api/users/${USER_ID}/login-stats?days=invalid`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_PARAMETER");
    expect(idpFetch).not.toHaveBeenCalled();
  });
});

describe("GET /api/users/:id/login-trends — 日別ログイントレンド", () => {
  const mockTrends = [
    { date: "2026-03-25", count: 5 },
    { date: "2026-03-26", count: 8 },
    { date: "2026-03-27", count: 3 },
  ];

  it("非UUID形式のIDで400を返す", async () => {
    const idpFetch = vi.fn();
    const app = buildApp(idpFetch);

    const res = await app.request("/api/users/not-a-uuid/login-trends");
    expect(res.status).toBe(400);
    expect(idpFetch).not.toHaveBeenCalled();
  });

  it("セッションなしで401を返す", async () => {
    const idpFetch = vi.fn();
    const app = buildApp(idpFetch);

    const res = await app.request(`/api/users/${USER_ID}/login-trends`);
    expect(res.status).toBe(401);
    expect(idpFetch).not.toHaveBeenCalled();
  });

  it("管理者セッションでIdPへプロキシしてトレンドを返す", async () => {
    const idpFetch = mockIdp(200, { data: mockTrends, days: 30 });
    const app = buildApp(idpFetch);

    const res = await app.request(`/api/users/${USER_ID}/login-trends`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ data: unknown[]; days: number }>();
    expect(body.data).toHaveLength(3);
    expect(body.days).toBe(30);
  });

  it("daysクエリパラメータをIdPへ転送する", async () => {
    const idpFetch = mockIdp(200, { data: mockTrends, days: 14 });
    const app = buildApp(idpFetch);

    await app.request(`/api/users/${USER_ID}/login-trends?days=14`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });

    const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
    expect(new URL(calledReq.url).searchParams.get("days")).toBe("14");
  });

  it("IdPが404を返した場合はそのまま伝播する", async () => {
    const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
    const app = buildApp(idpFetch);

    const res = await app.request(`/api/users/${NOT_FOUND_USER_ID}/login-trends`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });

    expect(res.status).toBe(404);
  });

  it("不正なdaysで400を返す", async () => {
    const idpFetch = vi.fn();
    const app = buildApp(idpFetch);

    const res = await app.request(`/api/users/${USER_ID}/login-trends?days=invalid`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_PARAMETER");
    expect(idpFetch).not.toHaveBeenCalled();
  });
});
