import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { buildSteamAuthUrl, verifySteamAssertion } from "./steam";

const endpoint = "https://steamcommunity.com/openid/login";
const ns = "http://specs.openid.net/auth/2.0";
const returnTo = `https://id.example/auth/steam/callback?state=${"s".repeat(32)}`;
const now = Date.parse("2026-11-11T01:00:00Z");
const steamId = "76561198000000000";
const valid = `ns:${ns}\nis_valid:true\n`;
function assertion(): URL {
  const url = new URL(returnTo);
  for (const [key, value] of Object.entries({
    ns,
    mode: "id_res",
    op_endpoint: endpoint,
    claimed_id: `https://steamcommunity.com/openid/id/${steamId}`,
    identity: `https://steamcommunity.com/openid/id/${steamId}`,
    return_to: returnTo,
    response_nonce: "2026-11-11T01:00:00Zsynthetic-nonce",
    assoc_handle: "synthetic-handle",
    signed: "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    sig: "a".repeat(27) + "=",
  }))
    url.searchParams.set(`openid.${key}`, value);
  return url;
}
let consumeNonce = vi.fn<(hash: string, expires: number) => Promise<boolean>>();
const verify = (url = assertion()) =>
  verifySteamAssertion({
    callbackUrl: url.href,
    expectedReturnTo: returnTo,
    consumeNonce,
    clock: () => now,
  });
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(valid)),
  );
  consumeNonce = vi.fn(async () => true);
});
afterEach(() => vi.unstubAllGlobals());

describe("Steam authorization", () => {
  it("requests OpenID directed identity with an exact return URL and HTTPS realm", () => {
    const url = new URL(buildSteamAuthUrl(returnTo));
    expect(url.origin + url.pathname).toBe(endpoint);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "openid.ns": ns,
      "openid.mode": "checkid_setup",
      "openid.return_to": returnTo,
      "openid.realm": "https://id.example/",
      "openid.identity": `${ns}/identifier_select`,
      "openid.claimed_id": `${ns}/identifier_select`,
    });
  });
  it.each([
    "https://id.example/callback",
    "http://id.example/callback?state=" + "s".repeat(32),
    returnTo + "#fragment",
    returnTo + "&state=duplicate",
    returnTo + "&extra=1",
    returnTo.replace("https://", "https://user:pass@"),
    returnTo.replace("s".repeat(32), "short"),
  ])("rejects unsafe return URL %s", (url) => expect(() => buildSteamAuthUrl(url)).toThrow());
});

describe("Steam assertion verification", () => {
  it("pins verification endpoint and copies signed response without forwarding outer state", async () => {
    expect(await verify()).toEqual({ steamId });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    const body = new URLSearchParams(init?.body as string);
    expect(body.get("openid.mode")).toBe("check_authentication");
    expect(body.has("state")).toBe(false);
    for (const [key, value] of assertion().searchParams) {
      if (key.startsWith("openid.") && key !== "openid.mode") expect(body.get(key)).toBe(value);
    }
    expect(consumeNonce).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      now + 600_000,
    );
  });
  it("accepts Valve's documented HTTP identifier spelling without fetching it", async () => {
    const url = assertion();
    url.searchParams.set("openid.claimed_id", `http://steamcommunity.com/openid/id/${steamId}`);
    url.searchParams.set("openid.identity", `http://steamcommunity.com/openid/id/${steamId}`);
    expect(await verify(url)).toEqual({ steamId });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["state", "wrong"],
    ["openid.ns", "wrong"],
    ["openid.mode", "cancel"],
    ["openid.mode", "setup_needed"],
    ["openid.mode", "check_authentication"],
    ["openid.op_endpoint", "https://evil.test/"],
    ["openid.op_endpoint", "http://steamcommunity.com/openid/login"],
    ["openid.return_to", returnTo + "&extra=1"],
    ["openid.identity", `https://steamcommunity.com/openid/id/${steamId}1`],
    ["openid.claimed_id", `https://steamcommunity.com.evil.test/openid/id/${steamId}`],
    ["openid.claimed_id", `https://steamcommunity.com/openid/id/${steamId}#fragment`],
    ["openid.signed", "op_endpoint,identity,return_to,response_nonce,assoc_handle"],
    [
      "openid.signed",
      "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle,identity",
    ],
    [
      "openid.signed",
      "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle,unknown",
    ],
    ["openid.sig", ""],
    ["openid.assoc_handle", ""],
    ["openid.assoc_handle", "a".repeat(1025)],
    ["openid.response_nonce", "2026-11-11T00:50:00Ztoo-old"],
    ["openid.response_nonce", "2026-11-11T01:01:01Zfuture"],
    ["openid.response_nonce", "2026-02-30T01:00:00Zinvalid-date"],
    ["openid.response_nonce", "2026-11-11T01:00:00Z"],
    ["openid.response_nonce", "2026-11-11T01:00:00Zbad\nnonce"],
  ])("rejects invalid %s before any verification request", async (key, value) => {
    const url = assertion();
    url.searchParams.set(key, value);
    await expect(verify(url)).rejects.toThrow(/^Steam assertion verification failed$/);
    expect(fetch).not.toHaveBeenCalled();
    expect(consumeNonce).not.toHaveBeenCalled();
  });
  it.each(["state", "openid.mode", "openid.identity", "openid.sig", "openid.return_to"])(
    "rejects duplicate %s before normalization",
    async (key) => {
      const url = assertion();
      url.searchParams.append(key, url.searchParams.get(key)!);
      await expect(verify(url)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["https://evil.test", "http://id.example", "https://id.example/other"])(
    "rejects callback destination mismatch %s",
    async (destination) => {
      const url = new URL(destination);
      url.search = assertion().search;
      await expect(verify(url)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("requires the original bounded query and refuses unknown fields", async () => {
    const url = assertion();
    url.searchParams.set("openid.extra", "ignored");
    await expect(verify(url)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    `ns:${ns}\nis_valid:false\n`,
    "is_valid:true\n",
    `ns:${ns}\nis_valid:true-ish\n`,
    `ns:${ns}\nis_valid:false\nis_valid:true\n`,
    `ns:${ns}\nis_valid:true\r\n`,
    "a".repeat(4097),
    `<html>is_valid:true</html>`,
  ])("rejects invalid direct verification responses", async (response) => {
    vi.mocked(fetch).mockResolvedValue(new Response(response));
    await expect(verify()).rejects.toThrow(/^Steam assertion verification failed$/);
    expect(consumeNonce).not.toHaveBeenCalled();
  });
  it.each([400, 429, 500, 503, 302])("never retries HTTP %i", async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response("echoed-assertion", { status }));
    await expect(verify()).rejects.toThrow(/^Steam assertion verification failed$/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(consumeNonce).not.toHaveBeenCalled();
  });
  it("sanitizes unknown network failure and does not retry", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("private-id"));
    await expect(verify()).rejects.toThrow(/^Steam assertion verification failed$/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(consumeNonce).not.toHaveBeenCalled();
  });
  it("rejects replay even when the OP returns a second positive response", async () => {
    const used = new Set<string>();
    consumeNonce.mockImplementation(async (hash) => {
      if (used.has(hash)) return false;
      used.add(hash);
      return true;
    });
    const results = await Promise.allSettled([verify(), verify()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("fails closed on nonce storage errors", async () => {
    consumeNonce.mockRejectedValue(new Error("storage-error"));
    await expect(verify()).rejects.toThrow(/^Steam assertion verification failed$/);
  });
  it("accepts the permitted clock-skew boundary and retains the nonce for its entire validity", async () => {
    const url = assertion();
    url.searchParams.set("openid.response_nonce", "2026-11-11T01:01:00Zfuture");
    expect(await verify(url)).toEqual({ steamId });
    expect(consumeNonce).toHaveBeenCalledWith(expect.any(String), now + 660_000);
  });
});

describe("Steam nonce expiry during asynchronous work", () => {
  const start = now + 599_999;
  it("rejects a positive provider response arriving at the expiry boundary before storage", async () => {
    const clock = vi
      .fn()
      .mockReturnValueOnce(start)
      .mockReturnValue(now + 600_000);
    await expect(
      verifySteamAssertion({
        callbackUrl: assertion().href,
        expectedReturnTo: returnTo,
        consumeNonce,
        clock,
      }),
    ).rejects.toThrow(/^Steam assertion verification failed$/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(consumeNonce).not.toHaveBeenCalled();
  });
  it("rejects expiry during atomic nonce consumption even if storage reports success", async () => {
    let time = start;
    consumeNonce.mockImplementation(async () => {
      time += 1;
      return true;
    });
    await expect(
      verifySteamAssertion({
        callbackUrl: assertion().href,
        expectedReturnTo: returnTo,
        consumeNonce,
        clock: () => time,
      }),
    ).rejects.toThrow(/^Steam assertion verification failed$/);
    expect(consumeNonce).toHaveBeenCalledOnce();
  });
  it("never accepts concurrent delayed responses after an expiring replay store has pruned them", async () => {
    let time = start;
    const entries = new Map<string, number>();
    consumeNonce.mockImplementation(async (hash, expiry) => {
      if (expiry <= time || (entries.get(hash) ?? 0) > time) return false;
      entries.set(hash, expiry);
      return true;
    });
    const respond: Array<(response: Response) => void> = [];
    vi.mocked(fetch).mockImplementation(
      () => new Promise<Response>((resolve) => respond.push(resolve)),
    );
    const run = () =>
      verifySteamAssertion({
        callbackUrl: assertion().href,
        expectedReturnTo: returnTo,
        consumeNonce,
        clock: () => time,
      });
    const pending = [run(), run()];
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(respond).toHaveLength(2);
    time = now + 600_000;
    for (const release of respond) release(new Response(valid));
    const results = await Promise.allSettled(pending);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(consumeNonce).not.toHaveBeenCalled();
  });
  it("accepts the last valid millisecond with an atomic unexpired reservation", async () => {
    expect(
      await verifySteamAssertion({
        callbackUrl: assertion().href,
        expectedReturnTo: returnTo,
        consumeNonce,
        clock: () => start,
      }),
    ).toEqual({ steamId });
  });
});
