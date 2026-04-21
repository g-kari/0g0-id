// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { showToast } from "../../lib/toast";

describe("showToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("creates a toast element appended to body", () => {
    showToast("Hello");
    const toast = document.body.querySelector("div");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toBe("Hello");
  });

  it("applies success background by default", () => {
    showToast("OK");
    const toast = document.body.querySelector("div")!;
    expect(toast.style.cssText).toContain("var(--color-success,#38a169)");
  });

  it("applies error background when type is error", () => {
    showToast("Fail", "error");
    const toast = document.body.querySelector("div")!;
    expect(toast.style.cssText).toContain("var(--color-danger,#e53e3e)");
  });

  it("removes toast after 3000ms", () => {
    showToast("Bye");
    expect(document.body.querySelector("div")).not.toBeNull();
    vi.advanceTimersByTime(3000);
    expect(document.body.querySelector("div")).toBeNull();
  });
});
