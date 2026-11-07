import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { exchangeGithubCode } from "./github";
import { exchangeGoogleCode } from "./google";
import { exchangeLineCode } from "./line";
import { exchangeTwitchCode } from "./twitch";
import { exchangeXCode } from "./x";

// These values are synthetic canaries, not real users or credentials.
const CANARY = "synthetic-oauth-secret-DO-NOT-LOG";
const EMAIL = "synthetic-person@example.invalid";
const params = {
  code: CANARY,
  clientId: "synthetic-client",
  clientSecret: CANARY,
  redirectUri: `https://example.invalid/callback?email=${EMAIL}`,
  codeVerifier: CANARY,
};
const providers = [
  { name: "Google", context: "oauth-google", exchange: exchangeGoogleCode },
  { name: "LINE", context: "oauth-line", exchange: exchangeLineCode },
  { name: "Twitch", context: "oauth-twitch", exchange: exchangeTwitchCode },
  { name: "GitHub", context: "oauth-github", exchange: exchangeGithubCode },
  { name: "X", context: "oauth-x", exchange: exchangeXCode },
] as const;
const errorBodies = [
  {
    name: "nested JSON with personal data and tokens",
    body: JSON.stringify({
      error: "invalid_grant",
      error_description: `${EMAIL} ${CANARY}`,
      profile: { name: "Synthetic Person", email: EMAIL },
      access_token: CANARY,
      refresh_token: CANARY,
    }),
  },
  {
    name: "URL-encoded error values",
    body: new URLSearchParams({ email: EMAIL, client_secret: CANARY }).toString(),
  },
  { name: "plain text and a multiline error", body: `${EMAIL}\nError: ${CANARY}\n at callback` },
  { name: "large arbitrary error body", body: `${CANARY} ${EMAIL} ${"x".repeat(32_768)}` },
] as const;

describe.each(providers)("$name token-exchange log minimization", (provider) => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("setTimeout", (callback: () => void) => {
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function expectFailureLog(status: number): void {
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        level: "error",
        ctx: provider.context,
        msg: `${provider.name} token exchange failed`,
        data: { status },
      }),
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    const output = JSON.stringify(errorSpy.mock.calls);
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain(EMAIL);
  }

  it.each(errorBodies)("omits $name without consuming the failed response", async ({ body }) => {
    const response = new Response(body, { status: 400 });
    const textSpy = vi.spyOn(response, "text");
    const jsonSpy = vi.spyOn(response, "json");
    vi.mocked(fetch).mockResolvedValueOnce(response);

    await expect(provider.exchange(params)).rejects.toThrow(
      new Error(`${provider.name} token exchange failed`),
    );

    expectFailureLog(400);
    expect(textSpy).not.toHaveBeenCalled();
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not let an unreadable error body mask the fixed exchange error", async () => {
    const response = new Response(CANARY, { status: 401 });
    const textSpy = vi.spyOn(response, "text").mockRejectedValue(new Error(CANARY));
    const jsonSpy = vi.spyOn(response, "json").mockRejectedValue(new Error(EMAIL));
    vi.mocked(fetch).mockResolvedValueOnce(response);

    await expect(provider.exchange(params)).rejects.toThrow(
      new Error(`${provider.name} token exchange failed`),
    );

    expectFailureLog(401);
    expect(textSpy).not.toHaveBeenCalled();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("preserves retries and logs only the final non-retryable HTTP status", async () => {
    const responses = [429, 503, 403].map((status) => new Response(CANARY, { status }));
    const readers = responses.map((response) => vi.spyOn(response, "text"));
    for (const response of responses) vi.mocked(fetch).mockResolvedValueOnce(response);

    await expect(provider.exchange(params)).rejects.toThrow(
      new Error(`${provider.name} token exchange failed`),
    );

    expectFailureLog(403);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const reader of readers) expect(reader).not.toHaveBeenCalled();
    expect(responses.every((response) => !response.bodyUsed)).toBe(true);
  });

  it("returns the successful token payload unchanged without logging it", async () => {
    const payload = {
      access_token: CANARY,
      refresh_token: CANARY,
      id_token: CANARY,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid",
    };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));

    await expect(provider.exchange(params)).resolves.toEqual(payload);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keeps invalid-JSON diagnostics fixed without logging the response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(`${EMAIL} ${CANARY}`, { status: 200 }));

    await expect(provider.exchange(params)).rejects.toThrow(
      new Error(`${provider.name} token exchange failed: Invalid JSON response`),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("preserves exhausted retry errors without reading or logging bodies", async () => {
    const responses = [1, 2, 3].map(() => new Response(CANARY, { status: 503 }));
    const readers = responses.map((response) => vi.spyOn(response, "text"));
    for (const response of responses) vi.mocked(fetch).mockResolvedValueOnce(response);

    await expect(provider.exchange(params)).rejects.toThrow(new Error("HTTP 503"));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(errorSpy).not.toHaveBeenCalled();
    for (const reader of readers) expect(reader).not.toHaveBeenCalled();
  });

  it("preserves network exception identity and the existing retry contract", async () => {
    const error = new Error(CANARY);
    vi.mocked(fetch).mockRejectedValue(error);

    await expect(provider.exchange(params)).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(errorSpy).not.toHaveBeenCalled();
    // Logging by an outer application error handler is a separate remaining scope.
  });
});

describe("GitHub HTTP-success error-payload log minimization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    CANARY,
    { nested: EMAIL, access_token: CANARY },
    true,
    `${CANARY}${"x".repeat(32_768)}`,
  ])("omits arbitrary truthy error fields while retaining the fixed rejection", async (error) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = new Response(
      JSON.stringify({ error, error_description: EMAIL, access_token: CANARY }),
      { status: 200 },
    );
    const textSpy = vi.spyOn(response, "text");
    const jsonSpy = vi.spyOn(response, "json");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response));

    await expect(exchangeGithubCode(params)).rejects.toThrow(
      new Error("GitHub token exchange failed"),
    );
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        level: "error",
        ctx: "oauth-github",
        msg: "GitHub token exchange failed",
        data: { status: 200 },
      }),
    );
    expect(textSpy).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledTimes(1);
    // The existing success/error contract requires parsing HTTP-200 JSON once.
  });
});
