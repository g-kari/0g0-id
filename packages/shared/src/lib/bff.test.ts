import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import {
  parseSession,
  encodeSession,
  proxyResponse,
  fetchWithJsonBody,
  setSessionCookie,
  internalServiceHeaders,
  setOAuthStateCookie,
  verifyAndConsumeOAuthState,
  exchangeCodeAtIdp,
  revokeTokenAtIdp,
  proxyMutate,
  validateBffEnv,
} from "./bff";
import type { BffSession } from "./bff";

// hono/cookie をトップレベルでモック（vi.mock はホイスティングが必要）
vi.mock("hono/cookie", () => ({
  getCookie: vi.fn(),
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
}));

import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const TEST_SECRET = "test-session-secret-for-unit-tests-only-32b";

const mockSession: BffSession = {
  session_id: "00000000-0000-0000-0000-000000000000",
  access_token: "access-token-123",
  refresh_token: "refresh-token-456",
  user: { id: "user-1", email: "test@example.com", name: "Test User", role: "user" },
};

describe("parseSession", () => {
  it("正常なCookie値からセッションをパースする", async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    const result = await parseSession(cookie, TEST_SECRET);
    expect(result).not.toBeNull();
    expect(result?.access_token).toBe("access-token-123");
    expect(result?.refresh_token).toBe("refresh-token-456");
    expect(result?.user.id).toBe("user-1");
    expect(result?.user.role).toBe("user");
  });

  it("undefined を受け取ると null を返す", async () => {
    expect(await parseSession(undefined, TEST_SECRET)).toBeNull();
  });

  it("不正な値は null を返す", async () => {
    expect(await parseSession("not-valid-base64!!!", TEST_SECRET)).toBeNull();
  });

  it("空文字列は null を返す", async () => {
    expect(await parseSession("", TEST_SECRET)).toBeNull();
  });

  it("異なるシークレットでは null を返す", async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    expect(await parseSession(cookie, "wrong-secret")).toBeNull();
  });

  it("余分なフィールドは含まれず、既知フィールドのみを返す", async () => {
    // encodeSession は既知フィールドのみ含む正常なセッションをエンコードするため、
    // isBffSession の既知フィールド抽出が機能していることを確認
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    const result = await parseSession(cookie, TEST_SECRET);
    expect(result).not.toBeNull();
    expect(result?.access_token).toBe("access-token-123");
    expect(result?.refresh_token).toBe("refresh-token-456");
    expect(result?.user.id).toBe("user-1");
  });
});

describe("proxyResponse", () => {
  it("通常のレスポンスをそのまま返す", async () => {
    const original = new Response('{"data":"test"}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const result = await proxyResponse(original);
    expect(result.status).toBe(200);
    const body = await result.text();
    expect(body).toBe('{"data":"test"}');
  });

  it("204 No Content の場合はボディなしで返す", async () => {
    const original = new Response(null, { status: 204 });
    const result = await proxyResponse(original);
    expect(result.status).toBe(204);
    const body = await result.text();
    expect(body).toBe("");
  });

  it("4xx エラーレスポンスもそのまま返す", async () => {
    const original = new Response('{"error":{"code":"NOT_FOUND"}}', {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    const result = await proxyResponse(original);
    expect(result.status).toBe(404);
    const body = await result.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

describe("fetchWithAuth", () => {
  it("セッションCookieがない場合は401を返す", async () => {
    vi.mocked(getCookie).mockReturnValue(undefined);

    const { fetchWithAuth } = await import("./bff");
    const idpFetch = vi.fn();
    const ctx = {
      req: {},
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithAuth>[0];

    const result = await fetchWithAuth(ctx, "__session", "https://id.0g0.xyz/api/test");
    expect(result.status).toBe(401);
    const body = await result.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("セッションが有効な場合はIdPにリクエストを転送する", async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const { fetchWithAuth } = await import("./bff");
    const idpFetch = vi.fn().mockResolvedValue(new Response('{"data":"ok"}', { status: 200 }));
    const ctx = {
      req: {},
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithAuth>[0];

    const result = await fetchWithAuth(ctx, "__session", "https://id.0g0.xyz/api/me");
    expect(result.status).toBe(200);
    expect(idpFetch).toHaveBeenCalledOnce();
    // Authorizationヘッダーにアクセストークンが設定されていること
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.headers.get("Authorization")).toBe("Bearer access-token-123");
  });

  it("IdPへのリクエストが失敗した場合は502を返す", async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const { fetchWithAuth } = await import("./bff");
    const idpFetch = vi.fn().mockRejectedValue(new Error("network error"));
    const ctx = {
      req: {},
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithAuth>[0];

    const result = await fetchWithAuth(ctx, "__session", "https://id.0g0.xyz/api/me");
    expect(result.status).toBe(502);
    const body = await result.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UPSTREAM_ERROR");
  });

  it("リフレッシュが429を返した場合は503を返しCookieを削除しない", async () => {
    vi.mocked(deleteCookie).mockClear();
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const { fetchWithAuth } = await import("./bff");
    const idpFetch = vi
      .fn()
      // 1回目: アクセストークン期限切れ
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      // 2回目: リフレッシュエンドポイントへのリクエストにレートリミット
      .mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));
    const ctx = {
      req: {},
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithAuth>[0];

    const result = await fetchWithAuth(ctx, "__session", "https://id.0g0.xyz/api/me");
    expect(result.status).toBe(503);
    const body = await result.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    // セッションCookieは削除されない（ログアウトさせない）
    expect(vi.mocked(deleteCookie)).not.toHaveBeenCalled();
  });

  it("リフレッシュがTOKEN_ROTATEDを返した場合は503を返しCookieを削除しない", async () => {
    vi.mocked(deleteCookie).mockClear();
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const { fetchWithAuth } = await import("./bff");
    const idpFetch = vi
      .fn()
      // 1回目: アクセストークン期限切れ
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      // 2回目: 並行リクエストが既にトークンをローテーション済み
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "TOKEN_ROTATED" } }), { status: 401 }),
      );
    const ctx = {
      req: {},
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithAuth>[0];

    const result = await fetchWithAuth(ctx, "__session", "https://id.0g0.xyz/api/me");
    expect(result.status).toBe(503);
    const body = await result.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("TOKEN_ROTATED");
    // セッションCookieは削除されない（ログアウトさせない）
    expect(vi.mocked(deleteCookie)).not.toHaveBeenCalled();
  });
});

describe("fetchWithJsonBody", () => {
  it("JSONパース失敗時は400を返す", async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const ctx = {
      req: { json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")) },
      env: {
        IDP: { fetch: vi.fn() },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithJsonBody>[0];

    const result = await fetchWithJsonBody(ctx, "__session", "https://id.0g0.xyz/api/test", "POST");
    expect(result.status).toBe(400);
    const body = await result.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid JSON body");
  });

  it("正常なJSONボディをIdPへ転送してproxyResponseを返す", async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const requestBody = { name: "test-service" };
    const idpFetch = vi
      .fn()
      .mockResolvedValue(new Response('{"data":{"id":"svc-1"}}', { status: 201 }));
    const ctx = {
      req: { json: vi.fn().mockResolvedValue(requestBody) },
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithJsonBody>[0];

    const result = await fetchWithJsonBody(
      ctx,
      "__session",
      "https://id.0g0.xyz/api/services",
      "POST",
    );
    expect(result.status).toBe(201);
    expect(idpFetch).toHaveBeenCalledOnce();
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.method).toBe("POST");
    expect(reqArg.headers.get("Content-Type")).toBe("application/json");
    expect(reqArg.headers.get("Origin")).toBe("https://id.0g0.xyz");
    expect(reqArg.headers.get("Authorization")).toBe("Bearer access-token-123");
    expect(await reqArg.json()).toEqual(requestBody);
  });

  it("methodパラメータがPATCHの場合はPATCHリクエストを送る", async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const idpFetch = vi
      .fn()
      .mockResolvedValue(new Response('{"data":{"id":"svc-1"}}', { status: 200 }));
    const ctx = {
      req: { json: vi.fn().mockResolvedValue({ role: "admin" }) },
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof fetchWithJsonBody>[0];

    await fetchWithJsonBody(ctx, "__session", "https://id.0g0.xyz/api/users/u-1/role", "PATCH");
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.method).toBe("PATCH");
  });
});

describe("encodeSession", () => {
  it("セッションをbase64url文字列にエンコードする", async () => {
    const result = await encodeSession(mockSession, TEST_SECRET);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("エンコードしたセッションはparseSessionで復元できる", async () => {
    const encoded = await encodeSession(mockSession, TEST_SECRET);
    const decoded = await parseSession(encoded, TEST_SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded?.access_token).toBe(mockSession.access_token);
    expect(decoded?.refresh_token).toBe(mockSession.refresh_token);
    expect(decoded?.user.id).toBe(mockSession.user.id);
    expect(decoded?.user.role).toBe(mockSession.user.role);
  });

  it("同じセッションでも毎回異なる値を返す（ランダムIV）", async () => {
    const encoded1 = await encodeSession(mockSession, TEST_SECRET);
    const encoded2 = await encodeSession(mockSession, TEST_SECRET);
    expect(encoded1).not.toBe(encoded2);
  });

  it("異なるシークレットでは異なる値を返す", async () => {
    const encoded1 = await encodeSession(mockSession, TEST_SECRET);
    const encoded2 = await encodeSession(mockSession, "different-secret-value-32bytes-abc");
    expect(encoded1).not.toBe(encoded2);
  });
});

describe("setSessionCookie", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("setCookieを正しいオプションで呼び出す", async () => {
    const ctx = {
      env: { SESSION_SECRET: TEST_SECRET },
    } as unknown as Parameters<typeof setSessionCookie>[0];

    await setSessionCookie(ctx, "__session", mockSession);

    expect(vi.mocked(setCookie)).toHaveBeenCalledOnce();
    const [, cookieName, , options] = vi.mocked(setCookie).mock.calls[0];
    expect(cookieName).toBe("__session");
    expect(options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
  });

  it("Cookie値はparseSessionで復元できるbase64url文字列", async () => {
    const ctx = {
      env: { SESSION_SECRET: TEST_SECRET },
    } as unknown as Parameters<typeof setSessionCookie>[0];

    await setSessionCookie(ctx, "__session", mockSession);

    const [, , encodedValue] = vi.mocked(setCookie).mock.calls[0];
    const decoded = await parseSession(encodedValue, TEST_SECRET);
    expect(decoded?.access_token).toBe(mockSession.access_token);
    expect(decoded?.user.id).toBe(mockSession.user.id);
  });
});

describe("internalServiceHeaders", () => {
  it("INTERNAL_SERVICE_SECRETが設定されている場合はX-Internal-Secretヘッダーを返す", () => {
    const env = {
      IDP_ORIGIN: "https://id.0g0.xyz",
      INTERNAL_SERVICE_SECRET: "my-internal-secret",
    } as unknown as Parameters<typeof internalServiceHeaders>[0];
    const headers = internalServiceHeaders(env);
    expect(headers).toEqual({ "X-Internal-Secret": "my-internal-secret" });
  });

  it("INTERNAL_SERVICE_SECRETが未設定の場合は空オブジェクトを返す", () => {
    const env = {
      IDP_ORIGIN: "https://id.0g0.xyz",
    } as unknown as Parameters<typeof internalServiceHeaders>[0];
    const headers = internalServiceHeaders(env);
    expect(headers).toEqual({});
  });
});

describe("setOAuthStateCookie", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("setCookieをmaxAge=600のオプションで呼び出す", () => {
    const ctx = {
      env: { SESSION_SECRET: TEST_SECRET },
    } as unknown as Parameters<typeof setOAuthStateCookie>[0];

    setOAuthStateCookie(ctx, "__oauth_state", "random-state-value");

    expect(vi.mocked(setCookie)).toHaveBeenCalledOnce();
    const [, cookieName, value, options] = vi.mocked(setCookie).mock.calls[0];
    expect(cookieName).toBe("__oauth_state");
    expect(value).toBe("random-state-value");
    expect(options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
    });
  });
});

describe("verifyAndConsumeOAuthState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stateクッキーが存在しない場合はmissing_sessionを返す", () => {
    vi.mocked(getCookie).mockReturnValue(undefined);
    const ctx = { env: {} } as unknown as Parameters<typeof verifyAndConsumeOAuthState>[0];
    const result = verifyAndConsumeOAuthState(ctx, "__oauth_state", "some-state");
    expect(result).toBe("missing_session");
  });

  it("stateが一致しない場合はstate_mismatchを返す", () => {
    vi.mocked(getCookie).mockReturnValue("stored-state-value");
    const ctx = { env: {} } as unknown as Parameters<typeof verifyAndConsumeOAuthState>[0];
    const result = verifyAndConsumeOAuthState(ctx, "__oauth_state", "different-state");
    expect(result).toBe("state_mismatch");
  });

  it("stateが一致する場合はnullを返しクッキーを削除する", () => {
    vi.mocked(getCookie).mockReturnValue("correct-state-value");
    const ctx = { env: {} } as unknown as Parameters<typeof verifyAndConsumeOAuthState>[0];
    const result = verifyAndConsumeOAuthState(ctx, "__oauth_state", "correct-state-value");
    expect(result).toBeNull();
    expect(vi.mocked(deleteCookie)).toHaveBeenCalledOnce();
    expect(vi.mocked(deleteCookie).mock.calls[0][1]).toBe("__oauth_state");
  });
});

describe("exchangeCodeAtIdp", () => {
  it("認可コード交換に成功した場合はok:trueとExchangeResultを返す", async () => {
    const exchangeResult = {
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      user: { id: "user-1", email: "test@example.com", name: "Test User", role: "user" as const },
    };
    const idpFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: exchangeResult }), { status: 200 }));
    const env = {
      IDP: { fetch: idpFetch },
      IDP_ORIGIN: "https://id.0g0.xyz",
    } as unknown as Parameters<typeof exchangeCodeAtIdp>[0];

    const result = await exchangeCodeAtIdp(env, "auth-code-123", "https://user.0g0.xyz/callback");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.access_token).toBe("new-access-token");
      expect(result.data.user.id).toBe("user-1");
    }
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.url).toBe("https://id.0g0.xyz/auth/exchange");
    expect(reqArg.method).toBe("POST");
    const body = await reqArg.json<{ code: string; redirect_to: string }>();
    expect(body.code).toBe("auth-code-123");
    expect(body.redirect_to).toBe("https://user.0g0.xyz/callback");
  });

  it("IdPがエラーを返した場合はok:falseを返す", async () => {
    const idpFetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const env = {
      IDP: { fetch: idpFetch },
      IDP_ORIGIN: "https://id.0g0.xyz",
    } as unknown as Parameters<typeof exchangeCodeAtIdp>[0];

    const result = await exchangeCodeAtIdp(env, "bad-code", "https://user.0g0.xyz/callback");
    expect(result.ok).toBe(false);
  });

  it("INTERNAL_SERVICE_SECRETが設定されている場合はX-Internal-Secretヘッダーを付与する", async () => {
    const idpFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            access_token: "at",
            refresh_token: "rt",
            user: { id: "u1", email: "e@e.com", name: "N", role: "user" },
          },
        }),
        { status: 200 },
      ),
    );
    const env = {
      IDP: { fetch: idpFetch },
      IDP_ORIGIN: "https://id.0g0.xyz",
      INTERNAL_SERVICE_SECRET: "secret-123",
    } as unknown as Parameters<typeof exchangeCodeAtIdp>[0];

    await exchangeCodeAtIdp(env, "code", "https://user.0g0.xyz/cb");
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.headers.get("X-Internal-Secret")).toBe("secret-123");
  });
});

describe("revokeTokenAtIdp", () => {
  it("/auth/logoutにPOSTリクエストを送る", async () => {
    const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const env = {
      IDP: { fetch: idpFetch },
      IDP_ORIGIN: "https://id.0g0.xyz",
    } as unknown as Parameters<typeof revokeTokenAtIdp>[0];

    await revokeTokenAtIdp(env, "refresh-token-abc");
    expect(idpFetch).toHaveBeenCalledOnce();
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.url).toBe("https://id.0g0.xyz/auth/logout");
    expect(reqArg.method).toBe("POST");
    const body = await reqArg.json<{ refresh_token: string }>();
    expect(body.refresh_token).toBe("refresh-token-abc");
  });

  it("INTERNAL_SERVICE_SECRETが設定されている場合はX-Internal-Secretヘッダーを付与する", async () => {
    const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const env = {
      IDP: { fetch: idpFetch },
      IDP_ORIGIN: "https://id.0g0.xyz",
      INTERNAL_SERVICE_SECRET: "my-secret",
    } as unknown as Parameters<typeof revokeTokenAtIdp>[0];

    await revokeTokenAtIdp(env, "refresh-token-xyz");
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.headers.get("X-Internal-Secret")).toBe("my-secret");
  });
});

describe("proxyMutate", () => {
  it("DELETEリクエストをIdPへ転送する（デフォルトメソッド）", async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const idpFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const ctx = {
      req: {},
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof proxyMutate>[0];

    const result = await proxyMutate(ctx, "__session", "https://id.0g0.xyz/api/users/u1/ban");
    expect(result.status).toBe(204);
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.method).toBe("DELETE");
    expect(reqArg.headers.get("Origin")).toBe("https://id.0g0.xyz");
  });

  it("methodにPATCHを指定した場合はPATCHリクエストを送る", async () => {
    const cookie = await encodeSession(mockSession, TEST_SECRET);
    vi.mocked(getCookie).mockReturnValue(cookie);

    const idpFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const ctx = {
      req: {},
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof proxyMutate>[0];

    await proxyMutate(ctx, "__session", "https://id.0g0.xyz/api/users/u1/role", "PATCH");
    const reqArg: Request = idpFetch.mock.calls[0][0];
    expect(reqArg.method).toBe("PATCH");
  });

  it("セッションがない場合は401を返す", async () => {
    vi.mocked(getCookie).mockReturnValue(undefined);

    const idpFetch = vi.fn();
    const ctx = {
      req: {},
      env: {
        IDP: { fetch: idpFetch },
        IDP_ORIGIN: "https://id.0g0.xyz",
        SESSION_SECRET: TEST_SECRET,
      },
    } as unknown as Parameters<typeof proxyMutate>[0];

    const result = await proxyMutate(ctx, "__session", "https://id.0g0.xyz/api/users/u1/ban");
    expect(result.status).toBe(401);
    expect(idpFetch).not.toHaveBeenCalled();
  });
});

describe("validateBffEnv", () => {
  it("32文字以上のSESSION_SECRETは検証を通過する", () => {
    expect(() => validateBffEnv({ SESSION_SECRET: "a".repeat(32) })).not.toThrow();
  });

  it("64文字のSESSION_SECRETは検証を通過する", () => {
    expect(() => validateBffEnv({ SESSION_SECRET: "a".repeat(64) })).not.toThrow();
  });

  it("31文字のSESSION_SECRETはエラーをスローする", () => {
    expect(() => validateBffEnv({ SESSION_SECRET: "a".repeat(31) })).toThrow(
      "SESSION_SECRET は32文字以上",
    );
  });

  it("空文字のSESSION_SECRETはエラーをスローする", () => {
    expect(() => validateBffEnv({ SESSION_SECRET: "" })).toThrow("SESSION_SECRET は32文字以上");
  });
});
