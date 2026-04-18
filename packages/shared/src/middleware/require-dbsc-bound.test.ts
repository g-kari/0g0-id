import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { requireDbscBoundSession } from "./require-dbsc-bound";
import { encodeSession } from "../lib/bff";
import type { BffSession } from "../lib/bff";
import type { BffEnv } from "../types";

const SESSION_SECRET = "a".repeat(64);
const SESSION_COOKIE = "__Host-test-session";

const baseSession: BffSession = {
  session_id: "session-abc",
  access_token: "access",
  refresh_token: "refresh",
  user: { id: "user-1", email: "u@example.com", name: "u", role: "admin" },
};

async function makeCookie(): Promise<string> {
  return encodeSession(baseSession, SESSION_SECRET);
}

function buildEnv(overrides: Partial<BffEnv> = {}): BffEnv {
  const fetcher: Fetcher = {
    fetch: vi.fn(),
  } as unknown as Fetcher;
  return {
    IDP: fetcher,
    IDP_ORIGIN: "https://id.0g0.xyz",
    SELF_ORIGIN: "https://admin.0g0.xyz",
    SESSION_SECRET,
    INTERNAL_SERVICE_SECRET_SELF: "admin-secret",
    ...overrides,
  } as BffEnv;
}

function buildApp(env: BffEnv, enforce: "env" | true | false = "env") {
  const app = new Hono<{ Bindings: BffEnv }>();
  app.use(
    "/api/*",
    requireDbscBoundSession({
      sessionCookieName: SESSION_COOKIE,
      loggerName: "test-dbsc",
      enforce,
      registrationPath: "/auth/dbsc/start",
    }),
  );
  app.get("/api/safe", (c) => c.json({ ok: true }));
  app.post("/api/dangerous", (c) => c.json({ ok: true }));
  return {
    app,
    request: (path: string, init: RequestInit = {}) =>
      app.request(new Request(`https://admin.0g0.xyz${path}`, init), undefined, env as never),
  };
}

function mockIdpStatus(env: BffEnv, body: unknown, status = 200): void {
  vi.mocked(env.IDP.fetch).mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("requireDbscBoundSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET（safe method）は IdP 問い合わせ無しで通過する", async () => {
    const env = buildEnv();
    const { request } = buildApp(env);
    const res = await request("/api/safe", { method: "GET" });
    expect(res.status).toBe(200);
    expect(env.IDP.fetch).not.toHaveBeenCalled();
  });

  it("セッションなしの POST は通過する（認証は呼び出し元で）", async () => {
    const env = buildEnv();
    const { request } = buildApp(env);
    const res = await request("/api/dangerous", { method: "POST" });
    expect(res.status).toBe(200);
    expect(env.IDP.fetch).not.toHaveBeenCalled();
  });

  it("enforce=env + DBSC_ENFORCE_SENSITIVE 未設定のとき、未バインドでも通過する（warn-only）", async () => {
    const env = buildEnv();
    const cookie = await makeCookie();
    mockIdpStatus(env, { data: { device_bound: false, device_bound_at: null } });
    const { request } = buildApp(env, "env");
    const res = await request("/api/dangerous", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(200);
  });

  it("enforce=true かつ未バインド → 403 + Secure-Session-Registration ヘッダを返す", async () => {
    const env = buildEnv();
    const cookie = await makeCookie();
    mockIdpStatus(env, { data: { device_bound: false, device_bound_at: null } });
    const { request } = buildApp(env, true);
    const res = await request("/api/dangerous", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("DBSC_BINDING_REQUIRED");
    const header = res.headers.get("Secure-Session-Registration");
    expect(header).toContain('path="/auth/dbsc/start"');
  });

  it("enforce=true かつバインド済み → 通過する", async () => {
    const env = buildEnv();
    const cookie = await makeCookie();
    mockIdpStatus(env, { data: { device_bound: true, device_bound_at: 1000 } });
    const { request } = buildApp(env, true);
    const res = await request("/api/dangerous", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(200);
  });

  it("env 強制モード + DBSC_ENFORCE_SENSITIVE=true + 未バインド → 403", async () => {
    const env = buildEnv({ DBSC_ENFORCE_SENSITIVE: "true" });
    const cookie = await makeCookie();
    mockIdpStatus(env, { data: { device_bound: false, device_bound_at: null } });
    const { request } = buildApp(env, "env");
    const res = await request("/api/dangerous", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(403);
  });

  it("DBSC_ENFORCE_SENSITIVE='TRUE '（trailing space・大文字）でも正規化して強制モードに切替わる", async () => {
    const env = buildEnv({ DBSC_ENFORCE_SENSITIVE: "TRUE " });
    const cookie = await makeCookie();
    mockIdpStatus(env, { data: { device_bound: false, device_bound_at: null } });
    const { request } = buildApp(env, "env");
    const res = await request("/api/dangerous", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(403);
  });

  it("DBSC_ENFORCE_SENSITIVE='1' は強制モードに切替わらない（true 文字列のみ受理）", async () => {
    const env = buildEnv({ DBSC_ENFORCE_SENSITIVE: "1" });
    const cookie = await makeCookie();
    mockIdpStatus(env, { data: { device_bound: false, device_bound_at: null } });
    const { request } = buildApp(env, "env");
    const res = await request("/api/dangerous", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(200);
  });

  it("IdP 応答異常（5xx） → fail-open で通過する", async () => {
    const env = buildEnv();
    const cookie = await makeCookie();
    mockIdpStatus(env, { error: { code: "INTERNAL_ERROR", message: "x" } }, 500);
    const { request } = buildApp(env, true);
    const res = await request("/api/dangerous", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(200);
  });

  it("IdP が device_bound を返さない異常応答 → fail-open で通過する", async () => {
    const env = buildEnv();
    const cookie = await makeCookie();
    mockIdpStatus(env, { data: {} });
    const { request } = buildApp(env, true);
    const res = await request("/api/dangerous", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(200);
  });

  it("IDP に正しい ボディと X-BFF-Origin / X-Internal-Secret を送る", async () => {
    const env = buildEnv();
    const cookie = await makeCookie();
    mockIdpStatus(env, { data: { device_bound: true, device_bound_at: 1 } });
    const { request } = buildApp(env, true);
    await request("/api/dangerous", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(env.IDP.fetch).toHaveBeenCalledTimes(1);
    const [req] = (env.IDP.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [Request];
    expect(req.url).toBe("https://id.0g0.xyz/auth/dbsc/status");
    expect(req.method).toBe("POST");
    expect(req.headers.get("X-BFF-Origin")).toBe("https://admin.0g0.xyz");
    expect(req.headers.get("X-Internal-Secret")).toBe("admin-secret");
    const body = (await req.json()) as { session_id: string };
    expect(body.session_id).toBe("session-abc");
  });
});
