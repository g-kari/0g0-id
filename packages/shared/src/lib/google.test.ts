import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { buildGoogleAuthUrl, exchangeGoogleCode, fetchGoogleUserInfo } from "./google";

describe("exchangeGoogleCode", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseParams = {
    code: "auth-code",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://example.com/callback",
    codeVerifier: "verifier",
  };

  it("正常時にトークンレスポンスを返す", async () => {
    const tokenResponse = { access_token: "token", token_type: "Bearer", expires_in: 3600 };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(tokenResponse), { status: 200 }),
    );
    const result = await exchangeGoogleCode(baseParams);
    expect(result.access_token).toBe("token");
  });

  it("HTTPエラー時に例外を投げる", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("error body", { status: 400 }));
    await expect(exchangeGoogleCode(baseParams)).rejects.toThrow("Google token exchange failed");
  });

  it("不正なJSONレスポンス時に明示的なエラーを投げる", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    await expect(exchangeGoogleCode(baseParams)).rejects.toThrow(
      "Google token exchange failed: Invalid JSON response",
    );
  });

  it("429応答時にリトライして最終的に成功する", async () => {
    const tokenResponse = { access_token: "token", token_type: "Bearer", expires_in: 3600 };
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(tokenResponse), { status: 200 }));
    // タイムアウトを短縮するためsetTimeoutをモック
    vi.stubGlobal("setTimeout", (fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const result = await exchangeGoogleCode(baseParams);
    expect(result.access_token).toBe("token");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("500応答が3回続いた場合は例外を投げる", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("server error", { status: 500 }));
    vi.stubGlobal("setTimeout", (fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    await expect(exchangeGoogleCode(baseParams)).rejects.toThrow("HTTP 500");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});

describe("fetchGoogleUserInfo", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("正常時にユーザー情報を返す", async () => {
    const userInfo = { sub: "123", email: "test@example.com", email_verified: true, name: "Test" };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(userInfo), { status: 200 }));
    const result = await fetchGoogleUserInfo("access-token");
    expect(result.email).toBe("test@example.com");
  });

  it("HTTPエラー時に例外を投げる", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 401 }));
    await expect(fetchGoogleUserInfo("bad-token")).rejects.toThrow(
      "Google userinfo fetch failed: 401",
    );
  });

  it("不正なJSONレスポンス時に明示的なエラーを投げる", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    await expect(fetchGoogleUserInfo("access-token")).rejects.toThrow(
      "Google userinfo fetch failed: Invalid JSON response",
    );
  });
});

describe("buildGoogleAuthUrl", () => {
  it("必要なパラメータを含む認可URLを生成する", () => {
    const url = buildGoogleAuthUrl({
      clientId: "test-client-id",
      redirectUri: "https://example.com/callback",
      state: "test-state",
      codeChallenge: "test-challenge",
    });

    const parsed = new URL(url);
    expect(parsed.hostname).toBe("accounts.google.com");
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://example.com/callback");
    expect(parsed.searchParams.get("state")).toBe("test-state");
    expect(parsed.searchParams.get("code_challenge")).toBe("test-challenge");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("response_type")).toBe("code");
  });

  it("デフォルトスコープはopenid email profile", () => {
    const url = buildGoogleAuthUrl({
      clientId: "id",
      redirectUri: "https://example.com/cb",
      state: "state",
      codeChallenge: "challenge",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("scope")).toBe("openid email profile");
  });

  it("カスタムスコープを指定できる", () => {
    const url = buildGoogleAuthUrl({
      clientId: "id",
      redirectUri: "https://example.com/cb",
      state: "state",
      codeChallenge: "challenge",
      scope: "openid email",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("scope")).toBe("openid email");
  });

  it("access_type=onlineが設定される", () => {
    const url = buildGoogleAuthUrl({
      clientId: "id",
      redirectUri: "https://example.com/cb",
      state: "state",
      codeChallenge: "challenge",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("access_type")).toBe("online");
  });
});
