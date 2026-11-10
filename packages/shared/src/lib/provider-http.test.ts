import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readProviderResponse } from "./provider-http";

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("bounded provider response", () => {
  it("counts UTF-8 bytes rather than string characters", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("ああ"));
    await expect(readProviderResponse("https://provider.test", {}, 5)).rejects.toThrow("too large");
  });
  it("accepts an exact byte limit", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("ああ"));
    expect(await readProviderResponse("https://provider.test", {}, 6)).toBe("ああ");
  });
  it("cancels a chunked oversized response without trusting Content-Length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
      },
      cancel,
    });
    vi.mocked(fetch).mockResolvedValue(new Response(body, { headers: { "Content-Length": "1" } }));
    await expect(readProviderResponse("https://provider.test", {}, 5)).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects invalid UTF-8", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array([255, 255])));
    await expect(readProviderResponse("https://provider.test", {})).rejects.toThrow();
  });
  it("does not read or return failed HTTP response bodies", async () => {
    const response = new Response("credential-echo", { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.mocked(fetch).mockResolvedValue(response);
    await expect(readProviderResponse("https://provider.test", {})).rejects.toThrow(
      /^Provider request failed$/,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
