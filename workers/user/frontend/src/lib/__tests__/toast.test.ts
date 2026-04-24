// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showToast } from "../../lib/toast";

describe("showToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("creates a toast element in the container", () => {
    showToast("Hello", "success");
    const container = document.getElementById("toast-container");
    expect(container).not.toBeNull();
    const toast = container!.querySelector(".toast");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toBe("Hello");
    expect(toast!.classList.contains("toast-success")).toBe(true);
  });

  it("creates error toast", () => {
    showToast("Error occurred", "error");
    const toast = document.querySelector(".toast-error");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toBe("Error occurred");
  });

  it("removes toast after timeout", () => {
    showToast("Temporary", "success");
    expect(document.querySelector(".toast")).not.toBeNull();

    vi.advanceTimersByTime(3000);
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("auto-creates container when missing", () => {
    showToast("Auto container", "success");
    const container = document.getElementById("toast-container");
    expect(container).not.toBeNull();
    expect(container!.className).toBe("toast-container");
  });

  it("defaults to success type", () => {
    showToast("Default");
    const toast = document.querySelector(".toast");
    expect(toast!.classList.contains("toast-success")).toBe(true);
  });
});
