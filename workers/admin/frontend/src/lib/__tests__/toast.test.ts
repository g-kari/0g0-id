// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { showToast } from "../../lib/toast";

describe("showToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("creates a toast element in auto-generated container", () => {
    showToast("Hello");
    const container = document.getElementById("toast-container");
    expect(container).not.toBeNull();
    const toast = container!.querySelector(".toast");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toBe("Hello");
  });

  it("applies success class by default", () => {
    showToast("OK");
    const toast = document.querySelector(".toast")!;
    expect(toast.classList.contains("toast-success")).toBe(true);
  });

  it("applies error class when type is error", () => {
    showToast("Fail", "error");
    const toast = document.querySelector(".toast")!;
    expect(toast.classList.contains("toast-error")).toBe(true);
  });

  it("removes toast after 3000ms", () => {
    showToast("Bye");
    expect(document.querySelector(".toast")).not.toBeNull();
    vi.advanceTimersByTime(3000);
    expect(document.querySelector(".toast")).toBeNull();
  });
});
