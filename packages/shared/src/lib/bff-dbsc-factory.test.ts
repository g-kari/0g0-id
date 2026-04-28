import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import type { BffEnv } from "../types";
import { createBffDbscRoutes } from "./bff-dbsc-factory";

// --- モック ---
vi.mock("./bff", () => ({
  parseSession: vi.fn(),
  setSessionCookie: vi.fn(),
  internalServiceHeaders: vi.fn(),
}));
vi.mock("./dbsc", () => ({
  verifyDbscRegistrationJwt: vi.fn(),
  buildSecureSessionChallengeHeader: vi.fn(),
}));
vi.mock("./logger", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));
vi.mock("./internal-secret-deprecation", () => ({
  logUpstreamDeprecation: vi.fn(),
}));
vi.mock("hono/cookie", () => ({
  getCookie: vi.fn(),
  deleteCookie: vi.fn(),
  setCookie: vi.fn(),
}));

import { parseSession, internalServiceHeaders } from "./bff";
import { verifyDbscRegistrationJwt, buildSecureSessionChallengeHeader } from "./dbsc";

// --- ヘルパー ---
const TEST_CONFIG = {
  sessionCookieName: "__Host-test-session",
  loggerName: "test-dbsc",
  credentialsCookieName: "__Host-test-cred",
};

const MOCK_SESSION = {
  session_id: "sess-001",
  access_token: "at-xxx",
  refresh_token: "rt-xxx",
  user: { id: "u1", email: "t@t.com", name: "T", role: "user" as const },
};

const BASE_URL = "https://user.0g0.xyz";

function createTestApp(): {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  idpFetch: ReturnType<typeof vi.fn>;
} {
  const idpFetch = vi.fn();
  const app = new Hono<{ Bindings: BffEnv }>();
  app.route("/auth/dbsc", createBffDbscRoutes(TEST_CONFIG));
  const env = {
    IDP: { fetch: idpFetch },
    IDP_ORIGIN: "https://id.0g0.xyz",
    SELF_ORIGIN: BASE_URL,
    SESSION_SECRET: "test-secret-32bytes-padding!!!!!",
    INTERNAL_SERVICE_SECRET_SELF: "internal-secret",
  };
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(new Request(`${BASE_URL}${path}`, init), undefined, env) as Promise<Response>,
    idpFetch,
  };
}

describe("POST /start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(internalServiceHeaders).mockReturnValue({ "X-Internal-Secret": "internal-secret" });
  });

  it("セッション無しで401を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(null);
    const { request } = createTestApp();
    const res = await request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: "a.b.c" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("Content-Type application/jwt でボディからJWTを読み取る", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(verifyDbscRegistrationJwt).mockResolvedValue({
      publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      claims: { jti: "jti-1" },
    } as never);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    const res = await request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/jwt" },
      body: "header.payload.signature",
    });
    expect(res.status).toBe(200);
    expect(verifyDbscRegistrationJwt).toHaveBeenCalledWith("header.payload.signature", {
      audience: "https://user.0g0.xyz",
    });
  });

  it("Content-Type application/json で { jwt } からJWTを読み取る", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(verifyDbscRegistrationJwt).mockResolvedValue({
      publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      claims: { jti: "jti-1" },
    } as never);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    const res = await request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: "a.b.c" }),
    });
    expect(res.status).toBe(200);
    expect(verifyDbscRegistrationJwt).toHaveBeenCalledWith("a.b.c", {
      audience: "https://user.0g0.xyz",
    });
  });

  it("JSONパース失敗で400を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request } = createTestApp();

    const res = await request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("JSON本文にjwtフィールドが無い場合400を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request } = createTestApp();

    const res = await request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "a.b.c" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("空のJWTで400を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request } = createTestApp();

    const res = await request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/jwt" },
      body: "   ",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("verifyDbscRegistrationJwt 失敗で400を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(verifyDbscRegistrationJwt).mockRejectedValue(new Error("bad JWT"));
    const { request } = createTestApp();

    const res = await request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: "a.b.c" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_JWT");
  });

  it("IdP bind が5xx失敗で500を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(verifyDbscRegistrationJwt).mockResolvedValue({
      publicJwk: { kty: "EC" },
      claims: {},
    } as never);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response("error", { status: 502 }));

    const res = await request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: "a.b.c" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("IdP bind が4xx失敗で400を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(verifyDbscRegistrationJwt).mockResolvedValue({
      publicJwk: { kty: "EC" },
      claims: {},
    } as never);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response("error", { status: 409 }));

    const res = await request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: "a.b.c" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("成功時200とセッション情報を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(verifyDbscRegistrationJwt).mockResolvedValue({
      publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      claims: { jti: "jti-1" },
    } as never);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    const res = await request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: "a.b.c" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      session_identifier: string;
      refresh_url: string;
      credentials: Array<{ type: string; name: string }>;
    }>();
    expect(body.session_identifier).toBe("sess-001");
    expect(body.refresh_url).toBe("/auth/dbsc/refresh");
    expect(body.credentials).toEqual([{ type: "cookie", name: "__Host-test-cred" }]);
  });
});

describe("POST /refresh — challenge フェーズ（proof ヘッダ無し）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(internalServiceHeaders).mockReturnValue({ "X-Internal-Secret": "internal-secret" });
  });

  it("セッション無しで401を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(null);
    const { request } = createTestApp();
    const res = await request("/auth/dbsc/refresh", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("IdP challenge が5xx失敗で500を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response("err", { status: 500 }));

    const res = await request("/auth/dbsc/refresh", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("IdP challenge が4xx失敗で400を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response("err", { status: 404 }));

    const res = await request("/auth/dbsc/refresh", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("IdP challenge 応答のJSONパース失敗で500を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response("not-json{", { status: 200 }));

    const res = await request("/auth/dbsc/refresh", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("IdP challenge 応答のZodバリデーション失敗で500を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request, idpFetch } = createTestApp();
    // スキーマに合わない形状
    idpFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: { wrong: true } }), { status: 200 }),
    );

    const res = await request("/auth/dbsc/refresh", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("buildSecureSessionChallengeHeader 失敗で500を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(buildSecureSessionChallengeHeader).mockImplementation(() => {
      throw new Error("invalid nonce");
    });
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: { nonce: "nonce-1", expires_at: 9999999999 } }), {
        status: 200,
      }),
    );

    const res = await request("/auth/dbsc/refresh", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("成功時403とSecure-Session-Challengeヘッダを返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    vi.mocked(buildSecureSessionChallengeHeader).mockReturnValue('"nonce-abc"');
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: { nonce: "nonce-abc", expires_at: 9999999999 } }), {
        status: 200,
      }),
    );

    const res = await request("/auth/dbsc/refresh", { method: "POST" });
    expect(res.status).toBe(403);
    expect(res.headers.get("Secure-Session-Challenge")).toBe('"nonce-abc"');
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("SESSION_CHALLENGE_REQUIRED");
  });
});

describe("POST /refresh — proof フェーズ（Sec-Session-Response ヘッダあり）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(internalServiceHeaders).mockReturnValue({ "X-Internal-Secret": "internal-secret" });
  });

  it("有効なJWT形式のproofヘッダでIdP verifyを呼ぶ", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    const res = await request("/auth/dbsc/refresh", {
      method: "POST",
      headers: { "Sec-Session-Response": "h.p.s" },
    });
    expect(res.status).toBe(200);
    // IdP にJWTが渡されていること
    const reqArg: Request = idpFetch.mock.calls[0][0];
    const body = await reqArg.json<{ session_id: string; jwt: string }>();
    expect(body.jwt).toBe("h.p.s");
    expect(body.session_id).toBe("sess-001");
  });

  it("resolveProofJwt が null を返す場合400を返す（不正なヘッダ値）", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request } = createTestApp();

    // 3 dot-separated parts でないヘッダ値、Content-Type も未指定
    const res = await request("/auth/dbsc/refresh", {
      method: "POST",
      headers: { "Sec-Session-Response": "not-a-jwt" },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("IdP verify が5xx失敗で500を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response("err", { status: 503 }));

    const res = await request("/auth/dbsc/refresh", {
      method: "POST",
      headers: { "Sec-Session-Response": "h.p.s" },
    });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("IdP verify が4xx失敗で400を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response("err", { status: 400 }));

    const res = await request("/auth/dbsc/refresh", {
      method: "POST",
      headers: { "Sec-Session-Response": "h.p.s" },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_PROOF");
  });

  it("成功時200とセッション情報を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    const res = await request("/auth/dbsc/refresh", {
      method: "POST",
      headers: { "Sec-Session-Response": "h.p.s" },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      session_identifier: string;
      refresh_url: string;
      credentials: Array<{ type: string; name: string }>;
    }>();
    expect(body.session_identifier).toBe("sess-001");
    expect(body.refresh_url).toBe("/auth/dbsc/refresh");
    expect(body.credentials).toEqual([{ type: "cookie", name: "__Host-test-cred" }]);
  });
});

describe("resolveProofJwt（/refresh 経由の間接テスト）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(internalServiceHeaders).mockReturnValue({ "X-Internal-Secret": "internal-secret" });
  });

  it("Content-Type application/jwt のボディからJWTを取得する", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    // proofHeader は空文字（Sec-Session-Response 無し扱いを避けるためダミーで設定、
    // でも 3 dot でない）→ Content-Type fallback
    const res = await request("/auth/dbsc/refresh", {
      method: "POST",
      headers: {
        "Sec-Session-Response": "invalid",
        "Content-Type": "application/jwt",
      },
      body: "jwt-h.jwt-p.jwt-s",
    });
    expect(res.status).toBe(200);
    const reqArg: Request = idpFetch.mock.calls[0][0];
    const body = await reqArg.json<{ jwt: string }>();
    expect(body.jwt).toBe("jwt-h.jwt-p.jwt-s");
  });

  it("Content-Type application/json のボディから { jwt } を取得する", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request, idpFetch } = createTestApp();
    idpFetch.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    const res = await request("/auth/dbsc/refresh", {
      method: "POST",
      headers: {
        "Sec-Session-Response": "invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jwt: "json-h.json-p.json-s" }),
    });
    expect(res.status).toBe(200);
    const reqArg: Request = idpFetch.mock.calls[0][0];
    const body = await reqArg.json<{ jwt: string }>();
    expect(body.jwt).toBe("json-h.json-p.json-s");
  });

  it("application/jwt で不正なボディの場合400を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request } = createTestApp();

    const res = await request("/auth/dbsc/refresh", {
      method: "POST",
      headers: {
        "Sec-Session-Response": "invalid",
        "Content-Type": "application/jwt",
      },
      body: "not-valid-jwt",
    });
    expect(res.status).toBe(400);
  });

  it("application/json で壊れたJSONの場合400を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request } = createTestApp();

    const res = await request("/auth/dbsc/refresh", {
      method: "POST",
      headers: {
        "Sec-Session-Response": "invalid",
        "Content-Type": "application/json",
      },
      body: "{broken",
    });
    expect(res.status).toBe(400);
  });

  it("fallback: 全取得方法が失敗した場合400を返す", async () => {
    vi.mocked(parseSession).mockResolvedValue(MOCK_SESSION);
    const { request } = createTestApp();

    const res = await request("/auth/dbsc/refresh", {
      method: "POST",
      headers: {
        "Sec-Session-Response": "invalid",
        "Content-Type": "text/plain",
      },
      body: "whatever",
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });
});
