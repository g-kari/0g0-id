import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

vi.mock("@0g0-id/shared", () => ({
  exchangeGoogleCode: vi.fn(),
  fetchGoogleUserInfo: vi.fn(),
  exchangeLineCode: vi.fn(),
  fetchLineUserInfo: vi.fn(),
  exchangeTwitchCode: vi.fn(),
  fetchTwitchUserInfo: vi.fn(),
  exchangeGithubCode: vi.fn(),
  fetchGithubUserInfo: vi.fn(),
  fetchGithubPrimaryEmail: vi.fn(),
  exchangeXCode: vi.fn(),
  fetchXUserInfo: vi.fn(),
  upsertUser: vi.fn(),
  upsertLineUser: vi.fn(),
  upsertTwitchUser: vi.fn(),
  upsertGithubUser: vi.fn(),
  upsertXUser: vi.fn(),
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
}));

import {
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  exchangeLineCode,
  fetchLineUserInfo,
  exchangeTwitchCode,
  fetchTwitchUserInfo,
  exchangeGithubCode,
  fetchGithubUserInfo,
  fetchGithubPrimaryEmail,
  exchangeXCode,
  fetchXUserInfo,
} from "@0g0-id/shared";
import type { IdpEnv, TokenPayload } from "@0g0-id/shared";
import { Hono } from "hono";
import { resolveProvider } from "./provider-resolution";
import type { OAuthProvider } from "@0g0-id/shared";

type Variables = { user: TokenPayload };

const mockEnv: Partial<IdpEnv> = {
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  LINE_CLIENT_ID: "line-id",
  LINE_CLIENT_SECRET: "line-secret",
  TWITCH_CLIENT_ID: "twitch-id",
  TWITCH_CLIENT_SECRET: "twitch-secret",
  GITHUB_CLIENT_ID: "github-id",
  GITHUB_CLIENT_SECRET: "github-secret",
  X_CLIENT_ID: "x-id",
  X_CLIENT_SECRET: "x-secret",
};

function createApp(provider: OAuthProvider): Hono<{ Bindings: IdpEnv; Variables: Variables }> {
  const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();
  app.post("/test", async (c) => {
    const result = await resolveProvider(c, provider, "code", "verifier", "https://callback");
    if (result.ok) {
      return c.json({ ok: true, sub: result.sub });
    }
    return result.response;
  });
  return app;
}

async function callProvider(provider: OAuthProvider): Promise<Response> {
  const app = createApp(provider);
  return app.request("/test", { method: "POST" }, mockEnv as IdpEnv);
}

// ---------- Google ----------

describe("resolveProvider - Google", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("正常: email_verified=true → ok=true", async () => {
    vi.mocked(exchangeGoogleCode).mockResolvedValue({
      access_token: "at",
      token_type: "Bearer",
      expires_in: 3600,
    });
    vi.mocked(fetchGoogleUserInfo).mockResolvedValue({
      sub: "google-sub-1",
      email: "user@example.com",
      email_verified: true,
      name: "Test User",
      picture: "https://pic.example.com/a.jpg",
    });

    const res = await callProvider("google");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toEqual({ ok: true, sub: "google-sub-1" });
  });

  it("email_verified=false → UNVERIFIED_EMAIL エラー", async () => {
    vi.mocked(exchangeGoogleCode).mockResolvedValue({
      access_token: "at",
      token_type: "Bearer",
      expires_in: 3600,
    });
    vi.mocked(fetchGoogleUserInfo).mockResolvedValue({
      sub: "google-sub-1",
      email: "user@example.com",
      email_verified: false,
      name: "Test User",
    });

    const res = await callProvider("google");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNVERIFIED_EMAIL");
  });

  it("exchangeGoogleCode が例外 → ok=false", async () => {
    vi.mocked(exchangeGoogleCode).mockRejectedValue(new Error("exchange failed"));

    const res = await callProvider("google");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("OAUTH_ERROR");
  });

  it("fetchGoogleUserInfo が例外 → ok=false", async () => {
    vi.mocked(exchangeGoogleCode).mockResolvedValue({
      access_token: "at",
      token_type: "Bearer",
      expires_in: 3600,
    });
    vi.mocked(fetchGoogleUserInfo).mockRejectedValue(new Error("fetch failed"));

    const res = await callProvider("google");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("OAUTH_ERROR");
  });
});

// ---------- LINE ----------

describe("resolveProvider - LINE", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("正常: email あり → ok=true", async () => {
    vi.mocked(exchangeLineCode).mockResolvedValue({
      access_token: "at",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid profile email",
    });
    vi.mocked(fetchLineUserInfo).mockResolvedValue({
      sub: "line-sub-1",
      email: "line@example.com",
      name: "LINE User",
      picture: "https://pic.example.com/line.jpg",
    });

    const res = await callProvider("line");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toEqual({ ok: true, sub: "line-sub-1" });
  });

  it("email なし → placeholder email で ok=true", async () => {
    vi.mocked(exchangeLineCode).mockResolvedValue({
      access_token: "at",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid profile email",
    });
    vi.mocked(fetchLineUserInfo).mockResolvedValue({
      sub: "line-sub-2",
      email: undefined,
      name: "LINE User",
    });

    const res = await callProvider("line");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toEqual({ ok: true, sub: "line-sub-2" });
  });
});

// ---------- Twitch ----------

describe("resolveProvider - Twitch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("正常: email 検証済み → ok=true", async () => {
    vi.mocked(exchangeTwitchCode).mockResolvedValue({
      access_token: "at",
      token_type: "bearer",
      expires_in: 3600,
      scope: ["openid", "user:read:email"],
    });
    vi.mocked(fetchTwitchUserInfo).mockResolvedValue({
      sub: "twitch-sub-1",
      email: "twitch@example.com",
      email_verified: true,
      preferred_username: "TwitchUser",
      picture: "https://pic.example.com/twitch.jpg",
    });

    const res = await callProvider("twitch");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toEqual({ ok: true, sub: "twitch-sub-1" });
  });

  it("email 未検証 → UNVERIFIED_EMAIL エラー", async () => {
    vi.mocked(exchangeTwitchCode).mockResolvedValue({
      access_token: "at",
      token_type: "bearer",
      expires_in: 3600,
      scope: ["openid", "user:read:email"],
    });
    vi.mocked(fetchTwitchUserInfo).mockResolvedValue({
      sub: "twitch-sub-1",
      email: "twitch@example.com",
      email_verified: false,
      preferred_username: "TwitchUser",
    });

    const res = await callProvider("twitch");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNVERIFIED_EMAIL");
  });

  it("email なし → placeholder で ok=true（UNVERIFIED_EMAIL にならない）", async () => {
    vi.mocked(exchangeTwitchCode).mockResolvedValue({
      access_token: "at",
      token_type: "bearer",
      expires_in: 3600,
      scope: ["openid", "user:read:email"],
    });
    vi.mocked(fetchTwitchUserInfo).mockResolvedValue({
      sub: "twitch-sub-2",
      preferred_username: "TwitchUser",
    });

    const res = await callProvider("twitch");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toEqual({ ok: true, sub: "twitch-sub-2" });
  });
});

// ---------- GitHub ----------

describe("resolveProvider - GitHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("正常 → ok=true, sub = String(githubUser.id)", async () => {
    vi.mocked(exchangeGithubCode).mockResolvedValue({
      access_token: "at",
      token_type: "bearer",
      scope: "read:user,user:email",
    });
    vi.mocked(fetchGithubUserInfo).mockResolvedValue({
      id: 12345,
      login: "ghuser",
      name: "GitHub User",
      email: null,
      avatar_url: "https://avatars.example.com/12345",
    });
    vi.mocked(fetchGithubPrimaryEmail).mockResolvedValue("gh@example.com");

    const res = await callProvider("github");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toEqual({ ok: true, sub: "12345" });
  });

  it("fetchGithubPrimaryEmail が null → placeholder email で ok=true", async () => {
    vi.mocked(exchangeGithubCode).mockResolvedValue({
      access_token: "at",
      token_type: "bearer",
      scope: "read:user,user:email",
    });
    vi.mocked(fetchGithubUserInfo).mockResolvedValue({
      id: 99999,
      login: "ghuser2",
      name: null,
      email: null,
      avatar_url: "https://avatars.example.com/99999",
    });
    vi.mocked(fetchGithubPrimaryEmail).mockResolvedValue(null);

    const res = await callProvider("github");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toEqual({ ok: true, sub: "99999" });
  });

  it("fetchGithubPrimaryEmail が例外 → ok=false", async () => {
    vi.mocked(exchangeGithubCode).mockResolvedValue({
      access_token: "at",
      token_type: "bearer",
      scope: "read:user,user:email",
    });
    vi.mocked(fetchGithubUserInfo).mockResolvedValue({
      id: 12345,
      login: "ghuser",
      name: "GitHub User",
      email: null,
      avatar_url: "https://avatars.example.com/12345",
    });
    vi.mocked(fetchGithubPrimaryEmail).mockRejectedValue(new Error("email fetch failed"));

    const res = await callProvider("github");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("OAUTH_ERROR");
  });
});

// ---------- X ----------

describe("resolveProvider - X", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("正常 → ok=true, 常に placeholder email", async () => {
    vi.mocked(exchangeXCode).mockResolvedValue({
      access_token: "at",
      token_type: "bearer",
      scope: "tweet.read users.read offline.access",
    });
    vi.mocked(fetchXUserInfo).mockResolvedValue({
      id: "x-sub-1",
      username: "xuser",
      name: "X User",
      profile_image_url: "https://pbs.example.com/x.jpg",
    });

    const res = await callProvider("x");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toEqual({ ok: true, sub: "x-sub-1" });
  });
});
