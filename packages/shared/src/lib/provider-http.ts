/** Bounded, single-attempt requests for login assertions and one-use authorization codes. */
export async function readProviderResponse(
  url: string,
  init: RequestInit,
  maxBytes = 16_384,
): Promise<string> {
  // Workers has no ambient cookie jar. The extra credentials field also protects Node/browser callers.
  const options = {
    ...init,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  } satisfies RequestInit & { credentials: "omit" };
  const response = await fetch(url, options);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Provider request failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("Provider response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

/** Reject non-HTTPS, fragment and credential-bearing destinations. */
export function requireProviderCallback(value: string): URL {
  const url = new URL(value);
  if (
    value.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.href !== value
  ) {
    throw new Error("Invalid provider callback");
  }
  return url;
}
