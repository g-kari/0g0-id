import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { encodeSession } from "@0g0-id/shared";
import dbscRoutes from "./dbsc";

const baseUrl = "https://admin.0g0.xyz";
const SESSION_COOKIE = "__Host-admin-session";
const SESSION_SECRET = "test-secret-32chars-long-padding-x";

interface TestEnv {
  IDP: { fetch: (req: Request) => Promise<Response> };
  IDP_ORIGIN: string;
  SESSION_SECRET: string;
  SELF_ORIGIN: string;
  INTERNAL_SERVICE_SECRET?: string;
}

function buildApp(idpFetch: (req: Request) => Promise<Response> = vi.fn(), env?: Partial<TestEnv>) {
  const app = new Hono<{ Bindings: TestEnv }>();
  app.route("/auth/dbsc", dbscRoutes);
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(new Request(`${baseUrl}${path}`, init), undefined, {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET,
        SELF_ORIGIN: baseUrl,
        ...env,
      } satisfies TestEnv),
  };
}

async function makeSessionCookie(): Promise<string> {
  const encoded = await encodeSession(
    {
      session_id: "00000000-0000-0000-0000-000000000000",
      access_token: "mock-at",
      refresh_token: "mock-rt",
      user: { id: "user-1", email: "admin@example.com", name: "Admin", role: "admin" },
    },
    SESSION_SECRET,
  );
  return `${SESSION_COOKIE}=${encoded}`;
}

async function makeRegistrationJwt(audience: string): Promise<string> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return await new SignJWT({ aud: audience })
    .setProtectedHeader({ alg: "ES256", typ: "jwt", jwk: publicJwk })
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

describe("admin /auth/dbsc/start", () => {
  beforeEach(() => vi.resetAllMocks());

  it("セッション無し → 401", async () => {
    const app = buildApp();
    const jwt = await makeRegistrationJwt(baseUrl);
    const res = await app.request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/jwt" },
      body: jwt,
    });
    expect(res.status).toBe(401);
  });

  it("不正な JWT → 400", async () => {
    const app = buildApp();
    const cookie = await makeSessionCookie();
    const res = await app.request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/jwt", Cookie: cookie },
      body: "not.a.jwt",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_JWT");
  });

  it("正規 JWT → IdP に bind を委譲して 200 を返す", async () => {
    const idpFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { session_id: "x", bound_at: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const app = buildApp(idpFetch, { INTERNAL_SERVICE_SECRET: "shared-secret" });
    const cookie = await makeSessionCookie();
    const jwt = await makeRegistrationJwt(baseUrl);

    const res = await app.request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/jwt", Cookie: cookie },
      body: jwt,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { refresh_url: string; credentials: unknown[] };
    expect(body.refresh_url).toBe("/auth/dbsc/refresh");
    expect(Array.isArray(body.credentials)).toBe(true);

    expect(idpFetch).toHaveBeenCalledOnce();
    const [req] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
    expect(req.url).toBe("https://id.0g0.xyz/auth/dbsc/bind");
    expect(req.method).toBe("POST");
    expect(req.headers.get("X-Internal-Secret")).toBe("shared-secret");
    expect(req.headers.get("X-BFF-Origin")).toBe(baseUrl);
    const sent = (await req.json()) as { session_id: string; public_jwk: { kty: string } };
    expect(sent.session_id).toBe("00000000-0000-0000-0000-000000000000");
    expect(sent.public_jwk.kty).toBe("EC");
    // 私鍵成分は決して送らない
    expect("d" in sent.public_jwk).toBe(false);
  });

  it("IdP が 4xx を返したら 400 INVALID_REQUEST に畳む（列挙攻撃対策）", async () => {
    const idpFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "ALREADY_BOUND" } }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const app = buildApp(idpFetch);
    const cookie = await makeSessionCookie();
    const jwt = await makeRegistrationJwt(baseUrl);

    const res = await app.request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/jwt", Cookie: cookie },
      body: jwt,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.code).not.toBe("ALREADY_BOUND");
  });

  it("IdP が 500 を返したら 500 にラップする", async () => {
    const idpFetch = vi.fn().mockResolvedValue(new Response("oops", { status: 500 }));
    const app = buildApp(idpFetch);
    const cookie = await makeSessionCookie();
    const jwt = await makeRegistrationJwt(baseUrl);

    const res = await app.request("/auth/dbsc/start", {
      method: "POST",
      headers: { "Content-Type": "application/jwt", Cookie: cookie },
      body: jwt,
    });
    expect(res.status).toBe(500);
  });
});

describe("admin /auth/dbsc/refresh", () => {
  beforeEach(() => vi.resetAllMocks());

  async function makeBoundKeys(): Promise<{ privateKey: CryptoKey; publicJwk: JWK }> {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    return { privateKey, publicJwk };
  }

  async function signProofJwt(
    privateKey: CryptoKey,
    audience: string,
    jti: string,
  ): Promise<string> {
    return await new SignJWT({ aud: audience })
      .setProtectedHeader({ alg: "ES256", typ: "jwt" })
      .setIssuedAt()
      .setJti(jti)
      .sign(privateKey);
  }

  it("セッション無し → 401", async () => {
    const app = buildApp();
    const res = await app.request("/auth/dbsc/refresh", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("proof 未提示の初回 → IdP に challenge を要求し 403 + Secure-Session-Challenge を返す", async () => {
    const idpFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { nonce: "abc123", expires_at: 9999 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const app = buildApp(idpFetch, { INTERNAL_SERVICE_SECRET: "shared-secret" });
    const cookie = await makeSessionCookie();

    const res = await app.request("/auth/dbsc/refresh", {
      method: "POST",
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get("Secure-Session-Challenge")).toBe('"abc123"');

    expect(idpFetch).toHaveBeenCalledOnce();
    const [req] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
    expect(req.url).toBe("https://id.0g0.xyz/auth/dbsc/challenge");
    expect(req.headers.get("X-Internal-Secret")).toBe("shared-secret");
    expect(req.headers.get("X-BFF-Origin")).toBe(baseUrl);
  });

  it("IdP challenge が 500 を返したら 500 にラップする", async () => {
    const idpFetch = vi.fn().mockResolvedValue(new Response("oops", { status: 500 }));
    const app = buildApp(idpFetch);
    const cookie = await makeSessionCookie();
    const res = await app.request("/auth/dbsc/refresh", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(500);
  });

  it("IdP challenge が 4xx を返したら 400 INVALID_REQUEST に畳む", async () => {
    const idpFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "INVALID_SESSION" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const app = buildApp(idpFetch);
    const cookie = await makeSessionCookie();
    const res = await app.request("/auth/dbsc/refresh", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("proof 提示時 → IdP /auth/dbsc/verify に委譲し成功応答を返す", async () => {
    const idpFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { session_id: "x", verified_at: 123 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const app = buildApp(idpFetch, { INTERNAL_SERVICE_SECRET: "shared-secret" });
    const cookie = await makeSessionCookie();
    const { privateKey } = await makeBoundKeys();
    const proofJwt = await signProofJwt(privateKey, baseUrl, "nonce-xyz");

    const res = await app.request("/auth/dbsc/refresh", {
      method: "POST",
      headers: { Cookie: cookie, "Sec-Session-Response": proofJwt },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { refresh_url: string; credentials: unknown[] };
    expect(body.refresh_url).toBe("/auth/dbsc/refresh");

    expect(idpFetch).toHaveBeenCalledOnce();
    const [req] = (idpFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
    expect(req.url).toBe("https://id.0g0.xyz/auth/dbsc/verify");
    expect(req.headers.get("X-BFF-Origin")).toBe(baseUrl);
    expect(req.headers.get("X-Internal-Secret")).toBe("shared-secret");
    const sent = (await req.json()) as { session_id: string; jwt: string; audience?: unknown };
    expect(sent.jwt).toBe(proofJwt);
    // audience は IdP 側で session.bff_origin を強制するため body に含めない
    expect(sent.audience).toBeUndefined();
  });

  it("IdP verify が 4xx → 400 INVALID_PROOF に畳む（列挙攻撃対策）", async () => {
    const idpFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "INVALID_PROOF" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const app = buildApp(idpFetch);
    const cookie = await makeSessionCookie();
    const { privateKey } = await makeBoundKeys();
    const proofJwt = await signProofJwt(privateKey, baseUrl, "nonce-1");

    const res = await app.request("/auth/dbsc/refresh", {
      method: "POST",
      headers: { Cookie: cookie, "Sec-Session-Response": proofJwt },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_PROOF");
  });

  it("proof が JWT 形式で無い場合は 400 INVALID_REQUEST", async () => {
    const app = buildApp();
    const cookie = await makeSessionCookie();
    const res = await app.request("/auth/dbsc/refresh", {
      method: "POST",
      headers: { Cookie: cookie, "Sec-Session-Response": "not-a-jwt" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
  });
});
