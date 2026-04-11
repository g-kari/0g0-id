import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import {
  buildGithubAuthUrl,
  exchangeGithubCode,
  fetchGithubUserInfo,
  fetchGithubPrimaryEmail,
} from "./github";

describe("buildGithubAuthUrl", () => {
  it("正しいGitHub認可URLを生成する", () => {
    const url = buildGithubAuthUrl({
      clientId: "test-client-id",
      redirectUri: "https://example.com/callback",
      state: "test-state",
      codeChallenge: "test-challenge",
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://github.com");
    expect(parsed.pathname).toBe("/login/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://example.com/callback");
    expect(parsed.searchParams.get("state")).toBe("test-state");
    expect(parsed.searchParams.get("code_challenge")).toBe("test-challenge");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toContain("read:user");
    expect(parsed.searchParams.get("scope")).toContain("user:email");
  });
});

describe("exchangeGithubCode", () => {
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
    const tokenResponse = {
      access_token: "github-access-token",
      token_type: "bearer",
      scope: "read:user,user:email",
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(tokenResponse), { status: 200 }),
    );

    const result = await exchangeGithubCode(baseParams);
    expect(result.access_token).toBe("github-access-token");
    expect(result.token_type).toBe("bearer");
  });

  it("Accept: application/json ヘッダーでリクエストする", async () => {
    const tokenResponse = { access_token: "token", token_type: "bearer", scope: "" };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(tokenResponse), { status: 200 }),
    );

    await exchangeGithubCode(baseParams);

    const options = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((options.headers as Record<string, string>)["Accept"]).toBe("application/json");
  });

  it("HTTPエラー時に例外を投げる", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("error body", { status: 400 }));

    await expect(exchangeGithubCode(baseParams)).rejects.toThrow("GitHub token exchange failed");
  });

  it("レスポンスにerrorフィールドがある場合に例外を投げる", async () => {
    const errorResponse = { error: "bad_verification_code", error_description: "invalid code" };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(errorResponse), { status: 200 }),
    );

    await expect(exchangeGithubCode(baseParams)).rejects.toThrow("GitHub token exchange failed");
  });

  it("不正なJSONレスポンス時に明示的なエラーを投げる", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    await expect(exchangeGithubCode(baseParams)).rejects.toThrow(
      "GitHub token exchange failed: Invalid JSON response",
    );
  });
});

describe("fetchGithubUserInfo", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("正常時にユーザー情報を返す", async () => {
    const userInfo = {
      id: 12345,
      login: "testuser",
      name: "Test User",
      email: "test@example.com",
      avatar_url: "https://avatars.githubusercontent.com/u/12345",
    };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(userInfo), { status: 200 }));

    const result = await fetchGithubUserInfo("test-access-token");
    expect(result.id).toBe(12345);
    expect(result.login).toBe("testuser");
    expect(result.name).toBe("Test User");
    expect(result.email).toBe("test@example.com");
    expect(result.avatar_url).toBe("https://avatars.githubusercontent.com/u/12345");
  });

  it("User-Agent: 0g0-id ヘッダーでリクエストする", async () => {
    const userInfo = { id: 1, login: "user", name: null, email: null, avatar_url: null };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(userInfo), { status: 200 }));

    await fetchGithubUserInfo("test-access-token");

    const options = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((options.headers as Record<string, string>)["User-Agent"]).toBe("0g0-id");
  });

  it("HTTPエラー時に例外を投げる", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    await expect(fetchGithubUserInfo("bad-token")).rejects.toThrow(
      "GitHub user info fetch failed: 401",
    );
  });

  it("不正なJSONレスポンス時に明示的なエラーを投げる", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    await expect(fetchGithubUserInfo("test-token")).rejects.toThrow(
      "GitHub user info fetch failed: Invalid JSON response",
    );
  });

  it("emailなしのユーザー情報も正常に返す", async () => {
    const userInfo = { id: 456, login: "noemail", name: null, email: null, avatar_url: null };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(userInfo), { status: 200 }));

    const result = await fetchGithubUserInfo("test-access-token");
    expect(result.id).toBe(456);
    expect(result.email).toBeNull();
  });
});

describe("fetchGithubPrimaryEmail", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("プライマリ・検証済みメールアドレスを返す", async () => {
    const emails = [
      { email: "secondary@example.com", primary: false, verified: true },
      { email: "primary@example.com", primary: true, verified: true },
      { email: "unverified@example.com", primary: false, verified: false },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(emails), { status: 200 }));

    const result = await fetchGithubPrimaryEmail("test-access-token");
    expect(result).toBe("primary@example.com");
  });

  it("未検証のプライマリメールは返さない", async () => {
    const emails = [
      { email: "unverified-primary@example.com", primary: true, verified: false },
      { email: "verified-secondary@example.com", primary: false, verified: true },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(emails), { status: 200 }));

    const result = await fetchGithubPrimaryEmail("test-access-token");
    expect(result).toBeNull();
  });

  it("メールが存在しない場合は null を返す", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const result = await fetchGithubPrimaryEmail("test-access-token");
    expect(result).toBeNull();
  });

  it("HTTPエラー時は例外を投げる", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    await expect(fetchGithubPrimaryEmail("bad-token")).rejects.toThrow(
      "GitHub Emails API failed with status 401",
    );
  });

  it("不正なJSONレスポンス時は例外を投げる", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    await expect(fetchGithubPrimaryEmail("test-token")).rejects.toThrow(
      "GitHub Emails API returned invalid JSON",
    );
  });
});
