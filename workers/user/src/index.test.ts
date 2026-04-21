import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

vi.mock("./middleware/csrf", () => ({
  userCsrfMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("./middleware/cors", () => ({
  userCorsMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { mockFetchWithAuth, mockProxyResponse } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockProxyResponse: vi.fn(),
}));

vi.mock("@0g0-id/shared", async (importOriginal) => ({
  ...(await importOriginal()),
  logger: () => async (_c: unknown, next: () => Promise<void>) => next(),
  securityHeaders: () => async (_c: unknown, next: () => Promise<void>) => next(),
  bodyLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
  bffCorsMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  bffCsrfMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  fetchWithAuth: mockFetchWithAuth,
  proxyResponse: mockProxyResponse,
  proxyGet: (cookieName: string, buildUrl: (c: any) => string) => async (c: any) => {
    const res = await mockFetchWithAuth(c, cookieName, buildUrl(c));
    return mockProxyResponse(res);
  },
  parseSession: vi.fn(),
  createLogger: vi
    .fn()
    .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  validateBffEnv: vi.fn(),
}));

import { fetchWithAuth, parseSession, proxyResponse, encodeSession } from "@0g0-id/shared";
import type { BffSession } from "@0g0-id/shared";
import app from "./index";

const mockEnv = {
  IDP: { fetch: vi.fn() } as unknown as Fetcher,
  IDP_ORIGIN: "https://id.0g0.xyz",
  SESSION_SECRET: "test-session-secret-for-unit-tests-only-32b",
};

describe("GET /api/health", () => {
  it("200を返してstatus okとworker名を含む", async () => {
    const res = await app.request(
      "https://user.0g0.xyz/api/health",
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ status: string; worker: string; timestamp: string }>();
    expect(body.status).toBe("ok");
    expect(body.worker).toBe("user");
    expect(typeof body.timestamp).toBe("string");
  });
});

describe("onError ハンドラ", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("未処理の例外で500とINTERNAL_ERRORを返す", async () => {
    // fetchWithAuth をスローさせて /api/me 経由で app.onError を通過させる
    vi.mocked(fetchWithAuth).mockRejectedValue(new Error("unexpected network error"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request(
      "https://user.0g0.xyz/api/me",
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    consoleSpy.mockRestore();

    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error");
  });
});

describe("DBSC 必須化ミドルウェアの配線", () => {
  const DBSC_SESSION_SECRET = "a".repeat(64);
  const SESSION_COOKIE_NAME = "__Host-user-session";

  const FAKE_SESSION: BffSession = {
    session_id: "11111111-2222-3333-4444-555555555555",
    access_token: "mock-access-token",
    refresh_token: "mock-refresh-token",
    user: { id: "user-1", email: "u@example.com", name: "U", role: "user" },
  };

  // 実 parseSession で復号できる本物の暗号化セッションを作る。
  // mock の parseSession は middleware 内では使われない（middleware は ../lib/bff
  // から直接 import しているため）。
  async function buildCookieHeader(): Promise<string> {
    const encoded = await encodeSession(FAKE_SESSION, DBSC_SESSION_SECRET);
    return `${SESSION_COOKIE_NAME}=${encoded}`;
  }

  // IdP の /auth/dbsc/status が未バインドを返す状況を作る。
  function mockUnboundIdp(): Fetcher {
    return {
      fetch: vi.fn(async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === "/auth/dbsc/status") {
          return new Response(JSON.stringify({ data: { device_bound: false } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    } as unknown as Fetcher;
  }

  function buildEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      IDP: mockUnboundIdp(),
      IDP_ORIGIN: "https://id.0g0.xyz",
      SELF_ORIGIN: "https://user.0g0.xyz",
      SESSION_SECRET: DBSC_SESSION_SECRET,
      DBSC_ENFORCE_SENSITIVE: "true",
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    // `@0g0-id/shared` の parseSession モックは middleware には効かないが、
    // 下流ハンドラ（profile routes 等）も parseSession を呼ぶため、
    // 意図しない 401 を避けるために同じセッションを返させる。
    vi.mocked(parseSession).mockResolvedValue(FAKE_SESSION);
  });

  // 403 を返した時に、middleware が IdP /auth/dbsc/status を 1 回呼んでいることを検証する。
  // これで「偶然別経路で 403」ではなく、確かに DBSC middleware が動いていることを保証する。
  function countDbscStatusCalls(idp: Fetcher): number {
    return (idp.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((call) => {
      const req = call[0] as Request;
      return new URL(req.url).pathname === "/auth/dbsc/status";
    }).length;
  }

  it("PATCH /api/me は DBSC_ENFORCE_SENSITIVE=true + 未バインドで 403 DBSC_BINDING_REQUIRED", async () => {
    const cookie = await buildCookieHeader();
    const idp = mockUnboundIdp();
    const env = buildEnv({ IDP: idp });

    const res = await app.request(
      "https://user.0g0.xyz/api/me",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "newname" }),
      },
      env as unknown as Record<string, string>,
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("DBSC_BINDING_REQUIRED");
    expect(res.headers.get("Secure-Session-Registration")).toContain("/auth/dbsc/start");
    expect(countDbscStatusCalls(idp)).toBe(1);
  });

  it("DELETE /api/me（アカウント削除）も同じく 403 — /api/me ベースパスも保護対象", async () => {
    const cookie = await buildCookieHeader();
    const idp = mockUnboundIdp();
    const env = buildEnv({ IDP: idp });

    const res = await app.request(
      "https://user.0g0.xyz/api/me",
      { method: "DELETE", headers: { Cookie: cookie } },
      env as unknown as Record<string, string>,
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("DBSC_BINDING_REQUIRED");
    expect(countDbscStatusCalls(idp)).toBe(1);
  });

  it("DELETE /api/connections/:id も同じく 403", async () => {
    const cookie = await buildCookieHeader();
    const idp = mockUnboundIdp();
    const env = buildEnv({ IDP: idp });

    const res = await app.request(
      "https://user.0g0.xyz/api/connections/svc-xyz",
      { method: "DELETE", headers: { Cookie: cookie } },
      env as unknown as Record<string, string>,
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("DBSC_BINDING_REQUIRED");
    expect(countDbscStatusCalls(idp)).toBe(1);
  });

  it("POST /api/device/approve も同じく 403", async () => {
    const cookie = await buildCookieHeader();
    const idp = mockUnboundIdp();
    const env = buildEnv({ IDP: idp });

    const res = await app.request(
      "https://user.0g0.xyz/api/device/approve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ user_code: "ABCD-1234", action: "approve" }),
      },
      env as unknown as Record<string, string>,
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("DBSC_BINDING_REQUIRED");
    expect(countDbscStatusCalls(idp)).toBe(1);
  });

  it("DELETE /api/providers/:provider も 403 — アカウント復旧経路保護", async () => {
    const cookie = await buildCookieHeader();
    const idp = mockUnboundIdp();
    const env = buildEnv({ IDP: idp });

    const res = await app.request(
      "https://user.0g0.xyz/api/providers/google",
      { method: "DELETE", headers: { Cookie: cookie } },
      env as unknown as Record<string, string>,
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("DBSC_BINDING_REQUIRED");
    expect(countDbscStatusCalls(idp)).toBe(1);
  });

  it("POST /auth/link も 403 — 新規 SNS 連携による恒久的乗っ取り動線保護", async () => {
    const cookie = await buildCookieHeader();
    const idp = mockUnboundIdp();
    const env = buildEnv({ IDP: idp });

    const res = await app.request(
      "https://user.0g0.xyz/auth/link",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
        body: "provider=google",
      },
      env as unknown as Record<string, string>,
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("DBSC_BINDING_REQUIRED");
    expect(countDbscStatusCalls(idp)).toBe(1);
  });

  it("POST /auth/dbsc/start は DBSC 登録フロー自体なので保護対象外（middleware に捕まらない）", async () => {
    const cookie = await buildCookieHeader();
    const idp = mockUnboundIdp();
    const env = buildEnv({ IDP: idp });

    // registration JWT 無しで叩くと dbscRoutes 側で 400 を返すが、重要なのは
    // 403 DBSC_BINDING_REQUIRED に畳まれないことと、/auth/dbsc/status が呼ばれないこと。
    const res = await app.request(
      "https://user.0g0.xyz/auth/dbsc/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({}),
      },
      env as unknown as Record<string, string>,
    );

    expect(res.status).not.toBe(403);
    expect(countDbscStatusCalls(idp)).toBe(0);
  });

  it("GET /api/me は SAFE_METHODS として DBSC チェックをスキップする", async () => {
    const cookie = await buildCookieHeader();
    const idp = mockUnboundIdp();
    const env = buildEnv({ IDP: idp });

    vi.mocked(fetchWithAuth).mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.mocked(proxyResponse).mockImplementation(async (res: Response) => res);

    await app.request(
      "https://user.0g0.xyz/api/me",
      { method: "GET", headers: { Cookie: cookie } },
      env as unknown as Record<string, string>,
    );

    const dbscCalls = (idp.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((call) => {
      const req = call[0] as Request;
      return new URL(req.url).pathname === "/auth/dbsc/status";
    });
    expect(dbscCalls.length).toBe(0);
  });

  it("DBSC_ENFORCE_SENSITIVE 未設定（warn-only）では 403 にならず、middleware は status 問い合わせ後 next() に進む", async () => {
    const cookie = await buildCookieHeader();
    const idp = mockUnboundIdp();
    const env = buildEnv({ DBSC_ENFORCE_SENSITIVE: undefined, IDP: idp });

    vi.mocked(proxyResponse).mockImplementation(async (res: Response) => res);

    const res = await app.request(
      "https://user.0g0.xyz/api/me",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "x" }),
      },
      env as unknown as Record<string, string>,
    );

    // warn-only なので 403 DBSC_BINDING_REQUIRED にはならない
    expect(res.status).not.toBe(403);
    // middleware は status を問い合わせて未バインドを観測している
    const dbscCalls = (idp.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((call) => {
      const req = call[0] as Request;
      return new URL(req.url).pathname === "/auth/dbsc/status";
    });
    expect(dbscCalls.length).toBe(1);
  });
});
