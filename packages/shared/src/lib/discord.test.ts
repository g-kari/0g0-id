import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { buildDiscordAuthUrl, exchangeDiscordCode, fetchDiscordUserInfo } from "./discord";

const params = {
  clientId: "123456789012345678",
  redirectUri: "https://id.example/auth/callback",
  state: "a".repeat(32),
  codeChallenge: "b".repeat(43),
};
const exchange = {
  ...params,
  code: "synthetic-code",
  clientSecret: "synthetic-secret",
  codeVerifier: "c".repeat(64),
};
const token = {
  access_token: "synthetic-token",
  token_type: "Bearer",
  scope: "identify",
  refresh_token: "discard-me",
};
const profile = {
  id: "987654321098765432",
  username: "test-user",
  global_name: "Test User",
  avatar: "a".repeat(32),
  email: "ignored@example.test",
};
const json = (data: unknown) => new Response(JSON.stringify(data));

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("Discord authorization", () => {
  it("pins the endpoint, state and S256, and requests only identify", () => {
    const url = new URL(buildDiscordAuthUrl(params));
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      scope: "identify",
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
    });
  });
  it.each([
    { redirectUri: "http://id.example/auth/callback" },
    { redirectUri: "https://user:pass@id.example/auth/callback" },
    { redirectUri: "https://id.example/auth/callback#fragment" },
    { redirectUri: "https://id.example/auth/callback?query=true" },
    { clientId: "123.4" },
    { clientId: "18446744073709551616" },
    { state: "short" },
    { state: "a".repeat(129) },
    { codeChallenge: "wrong" },
    { codeChallenge: "=".repeat(43) },
  ])("rejects malformed authorization parameters %j", (change) => {
    expect(() => buildDiscordAuthUrl({ ...params, ...change })).toThrow(
      "Invalid Discord authorization parameters",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Discord token exchange", () => {
  it("form-encodes credentials and PKCE, without retaining a refresh token", async () => {
    vi.mocked(fetch).mockResolvedValue(json(token));
    expect(await exchangeDiscordCode(exchange)).toEqual({ access_token: token.access_token });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://discord.com/api/oauth2/token");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new URLSearchParams(init?.body as string).get("code_verifier")).toBe(
      exchange.codeVerifier,
    );
    expect(new URLSearchParams(init?.body as string).get("client_secret")).toBe(
      exchange.clientSecret,
    );
  });
  it.each([
    {},
    { ...token, access_token: null },
    { ...token, access_token: "" },
    { ...token, access_token: "bad\r\nheader" },
    { ...token, token_type: "Basic" },
    { ...token, scope: "identify email" },
    { ...token, scope: undefined },
    { ...token, error: "echoed-secret" },
  ])("rejects invalid token envelopes without echoing provider data %j", async (body) => {
    vi.mocked(fetch).mockResolvedValue(json(body));
    await expect(exchangeDiscordCode(exchange)).rejects.toThrow(/^Discord token exchange failed$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([400, 429, 500, 503, 302])("never retries HTTP %i", async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response("secret", { status }));
    await expect(exchangeDiscordCode(exchange)).rejects.toThrow(/^Discord token exchange failed$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not leak network exceptions or retry uncertain exchanges", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("secret-token"));
    await expect(exchangeDiscordCode(exchange)).rejects.toThrow(/^Discord token exchange failed$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["not-json", "a".repeat(16385)])(
    "rejects malformed or oversized responses",
    async (body) => {
      vi.mocked(fetch).mockResolvedValue(new Response(body));
      await expect(exchangeDiscordCode(exchange)).rejects.toThrow(
        /^Discord token exchange failed$/,
      );
    },
  );
  it("rejects an invalid verifier before transmitting a code", async () => {
    await expect(exchangeDiscordCode({ ...exchange, codeVerifier: "short" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Discord identity", () => {
  it("returns only safe display fields and a pinned avatar URL", async () => {
    vi.mocked(fetch).mockResolvedValue(json(profile));
    expect(await fetchDiscordUserInfo("synthetic-token")).toEqual({
      id: profile.id,
      name: profile.global_name,
      picture: `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`,
    });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://discord.com/api/v10/users/@me");
  });
  it("supports missing optional display name and avatar", async () => {
    vi.mocked(fetch).mockResolvedValue(json({ id: profile.id, username: "tester" }));
    expect(await fetchDiscordUserInfo("synthetic-token")).toEqual({
      id: profile.id,
      name: "tester",
      picture: null,
    });
  });
  it.each([
    { ...profile, id: Number(profile.id) },
    { ...profile, id: "00123" },
    { ...profile, id: "18446744073709551616" },
    { ...profile, global_name: "" },
    { ...profile, avatar: "../../other" },
    { ...profile, avatar: "https://evil.test/a.png" },
    { ...profile, global_name: "x".repeat(129) },
  ])("rejects malformed identity %j", async (body) => {
    vi.mocked(fetch).mockResolvedValue(json(body));
    await expect(fetchDiscordUserInfo("synthetic-token")).rejects.toThrow(
      /^Discord user info fetch failed$/,
    );
  });
  it("rejects header injection before any request", async () => {
    await expect(fetchDiscordUserInfo("bad\r\nheader")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
