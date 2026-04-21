// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, formatDate, formatDatetime } from "../../lib/api";

describe("formatDate", () => {
  it("formats ISO string to ja-JP date", () => {
    const result = formatDate("2024-03-15T10:30:00Z");
    // ja-JP locale: YYYY/MM/DD
    expect(result).toContain("2024");
    expect(result).toContain("03");
    expect(result).toContain("15");
  });
});

describe("formatDatetime", () => {
  it("formats ISO string to ja-JP datetime", () => {
    const result = formatDatetime("2024-03-15T10:30:00Z");
    expect(result).toContain("2024");
    expect(result).toContain("03");
    expect(result).toContain("15");
  });
});

describe("apiFetch", () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = window.location;

  beforeEach(() => {
    // Mock window.location
    Object.defineProperty(window, "location", {
      value: { href: "" },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it("unwraps { data: ... } response on 200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: "1", name: "test" } }),
      clone: () => ({
        json: () => Promise.resolve({ data: { id: "1", name: "test" } }),
      }),
    });

    const result = await apiFetch<{ id: string; name: string }>("/api/test");
    expect(result).toEqual({ id: "1", name: "test" });
  });

  it("returns empty object on 204", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      clone: () => ({ json: () => Promise.reject() }),
    });

    const result = await apiFetch("/api/test");
    expect(result).toEqual({});
  });

  it("redirects to / on 401", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      clone: () => ({ json: () => Promise.reject() }),
    });

    await expect(apiFetch("/api/test")).rejects.toThrow("Unauthorized");
    expect(window.location.href).toBe("/");
  });

  it("retries once on 503 TOKEN_ROTATED", async () => {
    const tokenRotatedResponse = {
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: { code: "TOKEN_ROTATED", message: "Token rotated" } }),
      clone() {
        return {
          json: () =>
            Promise.resolve({ error: { code: "TOKEN_ROTATED", message: "Token rotated" } }),
        };
      },
    };

    const successResponse = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { ok: true } }),
      clone() {
        return { json: () => Promise.resolve({ data: { ok: true } }) };
      },
    };

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenRotatedResponse)
      .mockResolvedValueOnce(successResponse);

    const result = await apiFetch<{ ok: boolean }>("/api/test");
    expect(result).toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("returns error object on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { message: "Internal Server Error" } }),
      clone: () => ({
        json: () => Promise.resolve({ error: { message: "Internal Server Error" } }),
      }),
    });

    const result = await apiFetch("/api/test");
    expect(result).toEqual({
      error: { code: "HTTP_ERROR", message: "Internal Server Error" },
    });
  });
});
