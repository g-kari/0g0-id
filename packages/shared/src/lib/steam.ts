import { readProviderResponse, requireProviderCallback } from "./provider-http";

const ENDPOINT = "https://steamcommunity.com/openid/login";
const NAMESPACE = "http://specs.openid.net/auth/2.0";
const SELECT_ID = `${NAMESPACE}/identifier_select`;
const REQUIRED_SIGNED = [
  "op_endpoint",
  "claimed_id",
  "identity",
  "return_to",
  "response_nonce",
  "assoc_handle",
];
const ALLOWED_FIELDS = new Set(
  ["ns", "mode", ...REQUIRED_SIGNED, "signed", "sig", "invalidate_handle"].map(
    (key) => `openid.${key}`,
  ),
);
const MAX_AGE_MS = 600_000;
const CLOCK_SKEW_MS = 60_000;

function validateReturnTo(value: string): URL {
  const url = requireProviderCallback(value);
  // A fresh, server-generated state must be bound to an authenticated transaction cookie by the caller.
  if (
    url.searchParams.size !== 1 ||
    !/^[A-Za-z0-9_-]{22,128}$/.test(url.searchParams.get("state") ?? "")
  )
    throw new Error("Invalid Steam return URL");
  return url;
}

/** Steam's browser login uses OpenID 2.0, not OAuth or a Steam Web API key. */
export function buildSteamAuthUrl(returnTo: string): string {
  try {
    const callback = validateReturnTo(returnTo);
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({
      "openid.ns": NAMESPACE,
      "openid.mode": "checkid_setup",
      "openid.return_to": returnTo,
      "openid.realm": `${callback.origin}/`,
      "openid.identity": SELECT_ID,
      "openid.claimed_id": SELECT_ID,
    }).toString();
    return url.href;
  } catch {
    throw new Error("Invalid Steam authorization parameters");
  }
}

export interface SteamAssertionOptions {
  /** Full incoming URL, including the original, uncollapsed query string. */
  callbackUrl: string;
  /** Exact URL generated from a verified, unexpired, browser-bound server transaction. */
  expectedReturnTo: string;
  /** Atomically reject expired/reused hashes, otherwise insert until expiresAtMs. Use storage time; no KV get/put pair. */
  consumeNonce: (nonceHash: string, expiresAtMs: number) => Promise<boolean>;
  /** Injectable clock for synthetic tests; production callers should use the default wall clock. */
  clock?: () => number;
}

function parseDirectResponse(text: string): boolean {
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf(":");
    const key = line.slice(0, separator);
    if (separator < 1 || entries.has(key) || line.includes("\r")) return false;
    entries.set(key, line.slice(separator + 1));
  }
  return entries.get("ns") === NAMESPACE && entries.get("is_valid") === "true";
}

/**
 * Verify only pinned Steam assertions, then atomically consume the nonce before returning identity.
 * No dynamic discovery or callback-supplied network destination. No profile/ownership API access.
 */
export async function verifySteamAssertion(
  options: SteamAssertionOptions,
): Promise<{ steamId: string }> {
  try {
    const expected = validateReturnTo(options.expectedReturnTo);
    if (options.callbackUrl.length > 8192 || typeof options.consumeNonce !== "function")
      throw new Error();
    const incoming = new URL(options.callbackUrl);
    if (
      incoming.origin !== expected.origin ||
      incoming.pathname !== expected.pathname ||
      incoming.username ||
      incoming.password ||
      incoming.hash
    )
      throw new Error();
    const query = incoming.searchParams;
    const seen = new Set<string>();
    for (const [key] of query) {
      if (seen.has(key) || (key !== "state" && !ALLOWED_FIELDS.has(key))) throw new Error();
      seen.add(key);
    }
    if (
      query.get("state") !== expected.searchParams.get("state") ||
      query.get("openid.ns") !== NAMESPACE ||
      query.get("openid.mode") !== "id_res" ||
      query.get("openid.op_endpoint") !== ENDPOINT ||
      query.get("openid.return_to") !== options.expectedReturnTo
    )
      throw new Error();

    const claimedId = query.get("openid.claimed_id") ?? "";
    // Valve documents HTTP claimed IDs; accept that spelling or HTTPS, never fetch either.
    const match = /^https?:\/\/steamcommunity\.com\/openid\/id\/([1-9][0-9]{16})$/.exec(claimedId);
    if (!match || query.get("openid.identity") !== claimedId) throw new Error();
    const signed = (query.get("openid.signed") ?? "").split(",");
    if (
      new Set(signed).size !== signed.length ||
      REQUIRED_SIGNED.some((field) => !signed.includes(field)) ||
      signed.some(
        (field) => !ALLOWED_FIELDS.has(`openid.${field}`) || !query.has(`openid.${field}`),
      ) ||
      !/^[A-Za-z0-9+/]{20,256}={0,2}$/.test(query.get("openid.sig") ?? "") ||
      !(query.get("openid.assoc_handle") ?? "") ||
      (query.get("openid.assoc_handle")?.length ?? 0) > 1024
    )
      throw new Error();

    const nonce = query.get("openid.response_nonce") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z[\x21-\x7e]{1,235}$/.test(nonce)) throw new Error();
    const issuedAt = Date.parse(nonce.slice(0, 20));
    const clock = options.clock ?? Date.now;
    const now = clock();
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(issuedAt) ||
      new Date(issuedAt).toISOString().slice(0, 19) + "Z" !== nonce.slice(0, 20) ||
      issuedAt > now + CLOCK_SKEW_MS ||
      now >= issuedAt + MAX_AGE_MS
    )
      throw new Error();

    const body = new URLSearchParams();
    for (const [key, value] of query) {
      if (key.startsWith("openid.")) body.append(key, value);
    }
    body.set("openid.mode", "check_authentication");
    // Single attempt: uncertain results fail closed, with no automatic assertion replay.
    const response = await readProviderResponse(
      ENDPOINT,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      4096,
    );
    const verifiedAt = clock();
    if (
      !parseDirectResponse(response) ||
      !Number.isFinite(verifiedAt) ||
      issuedAt > verifiedAt + CLOCK_SKEW_MS ||
      verifiedAt >= issuedAt + MAX_AGE_MS
    )
      throw new Error();
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${ENDPOINT}\n${nonce}`),
    );
    const nonceHash = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if ((await options.consumeNonce(nonceHash, issuedAt + MAX_AGE_MS)) !== true) throw new Error();
    const consumedAt = clock();
    if (
      !Number.isFinite(consumedAt) ||
      issuedAt > consumedAt + CLOCK_SKEW_MS ||
      consumedAt >= issuedAt + MAX_AGE_MS
    )
      throw new Error();
    return { steamId: match[1]! };
  } catch {
    throw new Error("Steam assertion verification failed");
  }
}
