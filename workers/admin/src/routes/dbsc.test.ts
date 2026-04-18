import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
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
