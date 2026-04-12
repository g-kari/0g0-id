import { describe, it, expect, vi } from "vite-plus/test";
import { encodeSession, sha256 } from "@0g0-id/shared";
import { Hono } from "hono";
import sessionsRoutes from "./sessions";

const baseUrl = "http://localhost";
const SESSION_COOKIE = "__Host-user-session";
const validSessionId = "123e4567-e89b-12d3-a456-426614174000";

type IdpFetch = (req: Request) => Promise<Response>;

async function makeSessionCookie(opts: { refreshToken?: string } = {}): Promise<string> {
  const { refreshToken = "mock-refresh-token" } = opts;
  const session = {
    access_token: "mock-access-token",
    refresh_token: refreshToken,
    user: { id: "user-123", email: "user@example.com", name: "Test User", role: "user" as const },
  };
  return encodeSession(session, "test-secret");
}

function buildApp(idpFetch: IdpFetch) {
  const app = new Hono<{
    Bindings: { IDP: { fetch: IdpFetch }; IDP_ORIGIN: string; SESSION_SECRET: string };
  }>();
  app.route("/api/me/sessions", sessionsRoutes);
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(new Request(`${baseUrl}${path}`, init), undefined, {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: "test-secret",
      }),
  };
}

function mockIdp(status: number, body: unknown): IdpFetch {
  return vi.fn().mockResolvedValue(
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: status === 204 ? {} : { "Content-Type": "application/json" },
    }),
  );
}

// ===== GET /api/me/sessions =====

describe("GET /api/me/sessions", () => {
  it("セッションなしで401を返す（IdP未呼び出し）", async () => {
    const idpFetch = vi.fn();
    const app = buildApp(idpFetch);
    const res = await app.request("/api/me/sessions");
    expect(res.status).toBe(401);
    expect(idpFetch).not.toHaveBeenCalled();
  });

  it("有効なセッションでIdPにGETリクエストを送りレスポンスを返す", async () => {
    const sessions = [{ id: validSessionId, created_at: "2026-01-01T00:00:00Z" }];
    const idpFetch = mockIdp(200, { data: sessions });
    const app = buildApp(idpFetch);
    const res = await app.request("/api/me/sessions", {
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });
    expect(res.status).toBe(200);
    expect(idpFetch).toHaveBeenCalledTimes(1);
    const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
    expect(calledReq.url).toBe("https://id.0g0.xyz/api/users/me/tokens");
    expect(calledReq.headers.get("Authorization")).toBe("Bearer mock-access-token");
  });

  it("IdPが500を返すとその応答を伝播する", async () => {
    const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR" } });
    const app = buildApp(idpFetch);
    const res = await app.request("/api/me/sessions", {
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });
    expect(res.status).toBe(500);
  });
});

// ===== DELETE /api/me/sessions/others =====

describe("DELETE /api/me/sessions/others", () => {
  it("セッションなしで401を返す（IdP未呼び出し）", async () => {
    const idpFetch = vi.fn();
    const app = buildApp(idpFetch);
    const res = await app.request("/api/me/sessions/others", { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(idpFetch).not.toHaveBeenCalled();
  });

  it("不正なセッションCookieで401を返す（IdP未呼び出し）", async () => {
    const idpFetch = vi.fn();
    const app = buildApp(idpFetch);
    const res = await app.request("/api/me/sessions/others", {
      method: "DELETE",
      headers: { Cookie: `${SESSION_COOKIE}=invalid-value` },
    });
    expect(res.status).toBe(401);
    expect(idpFetch).not.toHaveBeenCalled();
  });

  it("有効なセッションでsha256(refresh_token)をtoken_hashとしてIdPにDELETEを送る", async () => {
    const refreshToken = "test-refresh-token-xyz";
    const idpFetch = mockIdp(204, null);
    const app = buildApp(idpFetch);
    const res = await app.request("/api/me/sessions/others", {
      method: "DELETE",
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie({ refreshToken })}` },
    });
    expect(res.status).toBe(204);
    expect(idpFetch).toHaveBeenCalledTimes(1);
    const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
    expect(calledReq.method).toBe("DELETE");
    expect(calledReq.url).toBe("https://id.0g0.xyz/api/users/me/tokens/others");
    const body = await calledReq.json<{ token_hash: string }>();
    expect(body.token_hash).toBe(await sha256(refreshToken));
  });

  it("IdPがエラーを返すとその応答を伝播する", async () => {
    const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR" } });
    const app = buildApp(idpFetch);
    const res = await app.request("/api/me/sessions/others", {
      method: "DELETE",
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });
    expect(res.status).toBe(500);
  });
});

// ===== DELETE /api/me/sessions/:sessionId =====

describe("DELETE /api/me/sessions/:sessionId", () => {
  it("セッションなしで401を返す（IdP未呼び出し）", async () => {
    const idpFetch = vi.fn();
    const app = buildApp(idpFetch);
    const res = await app.request(`/api/me/sessions/${validSessionId}`, { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(idpFetch).not.toHaveBeenCalled();
  });

  it("不正なUUID形式で400を返す（IdP未呼び出し）", async () => {
    const idpFetch = vi.fn();
    const app = buildApp(idpFetch);
    const res = await app.request("/api/me/sessions/not-a-uuid", {
      method: "DELETE",
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(idpFetch).not.toHaveBeenCalled();
  });

  it("有効なセッションとUUIDでIdPに特定トークンのDELETEを送る", async () => {
    const idpFetch = mockIdp(204, null);
    const app = buildApp(idpFetch);
    const res = await app.request(`/api/me/sessions/${validSessionId}`, {
      method: "DELETE",
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });
    expect(res.status).toBe(204);
    expect(idpFetch).toHaveBeenCalledTimes(1);
    const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
    expect(calledReq.url).toBe(`https://id.0g0.xyz/api/users/me/tokens/${validSessionId}`);
    expect(calledReq.method).toBe("DELETE");
  });

  it("IdPが404を返すとその応答を伝播する", async () => {
    const idpFetch = mockIdp(404, { error: { code: "NOT_FOUND" } });
    const app = buildApp(idpFetch);
    const res = await app.request(`/api/me/sessions/${validSessionId}`, {
      method: "DELETE",
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });
    expect(res.status).toBe(404);
  });
});

// ===== DELETE /api/me/sessions =====

describe("DELETE /api/me/sessions", () => {
  it("セッションなしで401を返す（IdP未呼び出し）", async () => {
    const idpFetch = vi.fn();
    const app = buildApp(idpFetch);
    const res = await app.request("/api/me/sessions", { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(idpFetch).not.toHaveBeenCalled();
  });

  it("有効なセッションで全セッションのDELETEをIdPに送る", async () => {
    const idpFetch = mockIdp(204, null);
    const app = buildApp(idpFetch);
    const res = await app.request("/api/me/sessions", {
      method: "DELETE",
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });
    expect(res.status).toBe(204);
    expect(idpFetch).toHaveBeenCalledTimes(1);
    const [calledReq] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
    expect(calledReq.method).toBe("DELETE");
    expect(calledReq.url).toBe("https://id.0g0.xyz/api/users/me/tokens");
  });

  it("IdPがエラーを返すとその応答を伝播する", async () => {
    const idpFetch = mockIdp(500, { error: { code: "INTERNAL_ERROR" } });
    const app = buildApp(idpFetch);
    const res = await app.request("/api/me/sessions", {
      method: "DELETE",
      headers: { Cookie: `${SESSION_COOKIE}=${await makeSessionCookie()}` },
    });
    expect(res.status).toBe(500);
  });
});
