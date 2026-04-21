import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatDate, formatDatetime, apiFetch } from "../../lib/api";

describe("formatDate", () => {
  it("formats ISO string to ja-JP date", () => {
    const result = formatDate("2025-01-15T10:30:00Z");
    // ja-JP format: YYYY/MM/DD
    expect(result).toMatch(/2025/);
    expect(result).toMatch(/01/);
    expect(result).toMatch(/15/);
  });
});

describe("formatDatetime", () => {
  it("formats ISO string to ja-JP datetime", () => {
    const result = formatDatetime("2025-01-15T10:30:00Z");
    expect(result).toMatch(/2025/);
    expect(result).toMatch(/01/);
    expect(result).toMatch(/15/);
  });
});

describe("apiFetch", () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.window?.location;

  beforeEach(() => {
    // Mock window.location
    Object.defineProperty(globalThis, "window", {
      value: { location: { href: "" } },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalLocation) {
      Object.defineProperty(globalThis, "window", {
        value: { location: originalLocation },
        writable: true,
        configurable: true,
      });
    }
  });

  it("unwraps { data: ... } on 200 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: "123" } }),
      clone: () => ({
        json: async () => ({ data: { id: "123" } }),
      }),
    });

    const result = await apiFetch<{ id: string }>("/api/test");
    expect(result).toEqual({ id: "123" });
  });

  it("returns undefined on 204 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      clone: () => ({
        json: async () => {
          throw new Error("no body");
        },
      }),
    });

    const result = await apiFetch("/api/test");
    expect(result).toBeUndefined();
  });

  it("redirects to / on 401 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }),
      clone: () => ({
        json: async () => ({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }),
      }),
    });

    await expect(apiFetch("/api/test")).rejects.toThrow("Unauthorized");
    expect(globalThis.window.location.href).toBe("/");
  });

  it("retries on 503 TOKEN_ROTATED", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: { code: "TOKEN_ROTATED", message: "Token rotated" } }),
        clone: () => ({
          json: async () => ({ error: { code: "TOKEN_ROTATED", message: "Token rotated" } }),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { retried: true } }),
        clone: () => ({
          json: async () => ({ data: { retried: true } }),
        }),
      });

    globalThis.fetch = mockFetch;
    const result = await apiFetch<{ retried: boolean }>("/api/test");
    expect(result).toEqual({ retried: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 403 DBSC_BINDING_REQUIRED with Secure-Session-Registration header", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({
          "Secure-Session-Registration": "something",
        }),
        json: async () => ({
          error: { code: "DBSC_BINDING_REQUIRED", message: "DBSC binding required" },
        }),
        clone: () => ({
          json: async () => ({
            error: { code: "DBSC_BINDING_REQUIRED", message: "DBSC binding required" },
          }),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { rebound: true } }),
        clone: () => ({
          json: async () => ({ data: { rebound: true } }),
        }),
      });

    globalThis.fetch = mockFetch;
    const result = await apiFetch<{ rebound: boolean }>("/api/test");
    expect(result).toEqual({ rebound: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws Error on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: "INTERNAL_ERROR", message: "Server error" } }),
      clone: () => ({
        json: async () => ({ error: { code: "INTERNAL_ERROR", message: "Server error" } }),
      }),
    });

    await expect(apiFetch("/api/test")).rejects.toThrow("Server error");
  });
});
