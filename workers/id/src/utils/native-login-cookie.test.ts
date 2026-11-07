import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { sealNativeCookie, openNativeCookie } from "./native-login-cookie";

const secret = "test-only-secret-".repeat(3);
const origin = "https://id.example.test";
afterEach(() => vi.useRealTimers());
describe("native cookie purpose, origin, expiry and size boundary", () => {
  it("round trips a confidential payload without exposing it in the cookie", async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const value = await sealNativeCookie(
      { privateValue: "not-public" },
      secret,
      "continuation",
      origin,
      exp,
    );
    expect(value).not.toContain("not-public");
    expect(await openNativeCookie(value, secret, "continuation", origin)).toEqual({
      privateValue: "not-public",
      purpose: "continuation",
      exp,
    });
  });
  it("rejects another purpose, origin, key and modified ciphertext", async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const value = await sealNativeCookie({ value: "private" }, secret, "browser", origin, exp);
    expect(await openNativeCookie(value, secret, "continuation", origin)).toBeNull();
    expect(
      await openNativeCookie(value, secret, "browser", "https://other.example.test"),
    ).toBeNull();
    expect(
      await openNativeCookie(value, "different-secret-".repeat(3), "browser", origin),
    ).toBeNull();
    expect(
      await openNativeCookie(
        `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`,
        secret,
        "browser",
        origin,
      ),
    ).toBeNull();
  });
  it("validates expiry on the server and will not issue a longer-lived envelope", async () => {
    const now = Math.floor(Date.now() / 1000);
    const value = await sealNativeCookie({}, secret, "browser", origin, now + 60);
    vi.useFakeTimers();
    vi.setSystemTime((now + 60) * 1000);
    expect(await openNativeCookie(value, secret, "browser", origin)).toBeNull();
    await expect(sealNativeCookie({}, secret, "browser", origin, now + 700)).rejects.toThrow();
    await expect(sealNativeCookie({}, secret, "browser", origin, now)).rejects.toThrow();
  });
  it("bounds encoded and decoded data", async () => {
    await expect(
      sealNativeCookie(
        { value: "x".repeat(2700) },
        secret,
        "browser",
        origin,
        Math.floor(Date.now() / 1000) + 60,
      ),
    ).rejects.toThrow();
    expect(await openNativeCookie("a".repeat(3601), secret, "browser", origin)).toBeNull();
  });
});
