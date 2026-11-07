import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Hono } from "hono";
import type { IdpEnv, OAuthProvider, TokenPayload, User } from "@0g0-id/shared";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
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
    // Keep the real createLogger and restErrorBody. Capture their actual console output.
  };
});

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
  upsertUser,
  upsertLineUser,
  upsertTwitchUser,
  upsertGithubUser,
  upsertXUser,
} from "@0g0-id/shared";
import { resolveProvider } from "./provider-resolution";

// All identities, personal-data values and credentials in these fixtures are synthetic.
const CANARY = "synthetic-resolver-token-DO-NOT-LOG";
const EMAIL = "synthetic-resolver@example.invalid";
const ID = "11111111-2222-3333-4444-555555555555";
const CALLBACK = "https://example.invalid/callback";
const db = {} as D1Database;
const env = Object.fromEntries(
  ["GOOGLE", "LINE", "TWITCH", "GITHUB", "X"].flatMap((provider) => [
    [`${provider}_CLIENT_ID`, "synthetic-client"],
    [`${provider}_CLIENT_SECRET`, CANARY],
  ]),
) as unknown as IdpEnv;
const storedUser: User = {
  id: ID,
  google_sub: null,
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: EMAIL,
  email_verified: 1,
  name: "Synthetic Person",
  picture: null,
  phone: null,
  address: null,
  role: "user",
  banned_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const commonTokens = { access_token: CANARY, token_type: "Bearer", expires_in: 3600 };
const providers = [
  {
    key: "google",
    name: "Google",
    sub: "synthetic-google-sub",
    exchange: vi.mocked(exchangeGoogleCode),
    fetchInfo: vi.mocked(fetchGoogleUserInfo),
    upsert: vi.mocked(upsertUser),
    prepare: () => {
      vi.mocked(exchangeGoogleCode).mockResolvedValue(commonTokens);
      vi.mocked(fetchGoogleUserInfo).mockResolvedValue({
        sub: "synthetic-google-sub",
        email: EMAIL,
        email_verified: true,
        name: "Synthetic Person",
      });
    },
    expectedUpsert: {
      id: ID,
      googleSub: "synthetic-google-sub",
      email: EMAIL,
      emailVerified: true,
      name: "Synthetic Person",
      picture: null,
    },
  },
  {
    key: "line",
    name: "LINE",
    sub: "synthetic-line-sub",
    exchange: vi.mocked(exchangeLineCode),
    fetchInfo: vi.mocked(fetchLineUserInfo),
    upsert: vi.mocked(upsertLineUser),
    prepare: () => {
      vi.mocked(exchangeLineCode).mockResolvedValue({ ...commonTokens, scope: "openid" });
      vi.mocked(fetchLineUserInfo).mockResolvedValue({
        sub: "synthetic-line-sub",
        email: EMAIL,
        email_verified: true,
        name: "Synthetic Person",
      });
    },
    expectedUpsert: {
      id: ID,
      lineSub: "synthetic-line-sub",
      email: EMAIL,
      isPlaceholderEmail: false,
      name: "Synthetic Person",
      picture: null,
    },
  },
  {
    key: "twitch",
    name: "Twitch",
    sub: "synthetic-twitch-sub",
    exchange: vi.mocked(exchangeTwitchCode),
    fetchInfo: vi.mocked(fetchTwitchUserInfo),
    upsert: vi.mocked(upsertTwitchUser),
    prepare: () => {
      vi.mocked(exchangeTwitchCode).mockResolvedValue({ ...commonTokens, scope: ["openid"] });
      vi.mocked(fetchTwitchUserInfo).mockResolvedValue({
        sub: "synthetic-twitch-sub",
        email: EMAIL,
        email_verified: true,
        preferred_username: "Synthetic Person",
      });
    },
    expectedUpsert: {
      id: ID,
      twitchSub: "synthetic-twitch-sub",
      email: EMAIL,
      isPlaceholderEmail: false,
      emailVerified: true,
      name: "Synthetic Person",
      picture: null,
    },
  },
  {
    key: "github",
    name: "GitHub",
    sub: "123",
    exchange: vi.mocked(exchangeGithubCode),
    fetchInfo: vi.mocked(fetchGithubUserInfo),
    upsert: vi.mocked(upsertGithubUser),
    prepare: () => {
      vi.mocked(exchangeGithubCode).mockResolvedValue({ ...commonTokens, scope: "read:user" });
      vi.mocked(fetchGithubUserInfo).mockResolvedValue({
        id: 123,
        login: "synthetic-login",
        name: null,
        email: null,
        avatar_url: null,
      });
      vi.mocked(fetchGithubPrimaryEmail).mockResolvedValue(EMAIL);
    },
    expectedUpsert: {
      id: ID,
      githubSub: "123",
      email: EMAIL,
      isPlaceholderEmail: false,
      name: "synthetic-login",
      picture: null,
    },
  },
  {
    key: "x",
    name: "X",
    sub: "synthetic-x-sub",
    exchange: vi.mocked(exchangeXCode),
    fetchInfo: vi.mocked(fetchXUserInfo),
    upsert: vi.mocked(upsertXUser),
    prepare: () => {
      vi.mocked(exchangeXCode).mockResolvedValue({ ...commonTokens, scope: "users.read" });
      vi.mocked(fetchXUserInfo).mockResolvedValue({
        id: "synthetic-x-sub",
        name: null,
        username: "synthetic-login",
      });
    },
    expectedUpsert: {
      id: ID,
      xSub: "synthetic-x-sub",
      email: "x_synthetic-x-sub@x.placeholder",
      isPlaceholderEmail: true,
      name: "synthetic-login",
      picture: null,
    },
  },
] as const;
const stages = [
  ...providers.flatMap((provider) => [
    {
      name: `${provider.name} exchange`,
      provider,
      fail: (value: unknown) => provider.exchange.mockRejectedValueOnce(value),
      log: `[oauth-${provider.key}] Failed to exchange code`,
      message: `Failed to exchange ${provider.name} code`,
      fetchCalls: 0,
    },
    {
      name: `${provider.name} userinfo`,
      provider,
      fail: (value: unknown) => provider.fetchInfo.mockRejectedValueOnce(value),
      log: `[oauth-${provider.key}] Failed to fetch user info`,
      message: `Failed to fetch ${provider.name} user info`,
      fetchCalls: 1,
    },
  ]),
  {
    name: "GitHub primary email",
    provider: providers[3],
    fail: (value: unknown) => vi.mocked(fetchGithubPrimaryEmail).mockRejectedValueOnce(value),
    log: "[oauth-github] Failed to fetch primary email",
    message: "Failed to fetch GitHub email",
    fetchCalls: 1,
  },
];
const thrownValues = [
  {
    name: "Error message/stack/cause",
    make: () => {
      const value = new Error(`${EMAIL} ${CANARY}`, { cause: { access_token: CANARY } });
      value.stack = `Error: ${CANARY}\n at https://example.invalid/${EMAIL}`;
      return { value, readers: [] };
    },
  },
  {
    name: "Error with throwing accessors",
    make: () => {
      const value = new Error();
      const read = vi.fn(() => {
        throw new Error(CANARY);
      });
      Object.defineProperty(value, "stack", { get: read });
      Object.defineProperty(value, "message", { get: read });
      Object.defineProperty(value, "cause", { get: read });
      return { value, readers: [read] };
    },
  },
  { name: "primitive string", make: () => ({ value: `${EMAIL} ${CANARY}`, readers: [] }) },
  {
    name: "nested object",
    make: () => ({ value: { email: EMAIL, details: { refresh_token: CANARY } }, readers: [] }),
  },
  {
    name: "circular object",
    make: () => {
      const value: { email: string; self?: unknown } = { email: EMAIL };
      value.self = value;
      return { value, readers: [] };
    },
  },
  {
    name: "object with throwing serialization hooks",
    make: () => {
      const read = vi.fn(() => {
        throw new Error(CANARY);
      });
      return {
        value: {
          get email() {
            return read();
          },
          toJSON: read,
          toString: read,
        },
        readers: [read],
      };
    },
  },
  { name: "BigInt", make: () => ({ value: 1n, readers: [] }) },
  { name: "null", make: () => ({ value: null, readers: [] }) },
  { name: "undefined", make: () => ({ value: undefined, readers: [] }) },
];

function appFor(
  provider: OAuthProvider,
): Hono<{ Bindings: IdpEnv; Variables: { user: TokenPayload } }> {
  const app = new Hono<{ Bindings: IdpEnv; Variables: { user: TokenPayload } }>();
  app.get("/fixture", async (c) => {
    const result = await resolveProvider(c, provider, CANARY, CANARY, CALLBACK);
    if (!result.ok) return result.response;
    await result.upsert(db, ID);
    return c.json({ ok: true, sub: result.sub });
  });
  return app;
}

describe("real provider resolver and logger privacy boundary", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected fixture network call")));
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const provider of providers) {
      provider.prepare();
      provider.upsert.mockResolvedValue(storedUser);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function expectFixedLog(message: string): void {
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ level: "error", ctx: "auth", msg: message }),
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain(EMAIL);
    expect(output).not.toContain(ID);
    expect(fetch).not.toHaveBeenCalled();
  }

  describe.each(stages)("$name failure", (stage) => {
    it.each(thrownValues)(
      "omits $name and preserves the fixed HTTP400 response",
      async (fixture) => {
        const { value, readers } = fixture.make();
        stage.fail(value);

        const response = await appFor(stage.provider.key).request("/fixture", {}, env);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: { code: "OAUTH_ERROR", message: stage.message },
        });
        expectFixedLog(stage.log);
        for (const read of readers) expect(read).not.toHaveBeenCalled();
        expect(stage.provider.exchange).toHaveBeenCalledTimes(1);
        expect(stage.provider.fetchInfo).toHaveBeenCalledTimes(stage.fetchCalls);
        if (stage.fetchCalls) expect(stage.provider.fetchInfo).toHaveBeenCalledWith(CANARY);
        for (const provider of providers) expect(provider.upsert).not.toHaveBeenCalled();
      },
    );
  });

  it.each(providers)(
    "keeps $name successful resolution and upsert mapping unchanged",
    async (provider) => {
      const response = await appFor(provider.key).request("/fixture", {}, env);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, sub: provider.sub });
      expect(provider.upsert).toHaveBeenCalledExactlyOnceWith(db, provider.expectedUpsert);
      expect(provider.fetchInfo).toHaveBeenCalledExactlyOnceWith(CANARY);
      expect(provider.exchange).toHaveBeenCalledExactlyOnceWith({
        code: CANARY,
        clientId: "synthetic-client",
        clientSecret: CANARY,
        redirectUri: CALLBACK,
        codeVerifier: CANARY,
      });
      if (provider.key === "github")
        expect(fetchGithubPrimaryEmail).toHaveBeenCalledExactlyOnceWith(CANARY);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(providers)(
    "allows a later successful $name request after a failed exchange",
    async (provider) => {
      provider.exchange.mockRejectedValueOnce(new Error(`${EMAIL} ${CANARY}`));
      const app = appFor(provider.key);

      const failed = await app.request("/fixture", {}, env);
      const recovered = await app.request("/fixture", {}, env);

      expect(failed.status).toBe(400);
      expect(recovered.status).toBe(200);
      await expect(recovered.json()).resolves.toEqual({ ok: true, sub: provider.sub });
      expect(provider.upsert).toHaveBeenCalledExactlyOnceWith(db, provider.expectedUpsert);
      expectFixedLog(`[oauth-${provider.key}] Failed to exchange code`);
    },
  );
});
