// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showToast } from "../../lib/toast";

describe("showToast", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("creates a toast element in the container", () => {
    showToast("Hello", "success");
    const toast = container.querySelector(".toast");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toBe("Hello");
    expect(toast!.classList.contains("toast-success")).toBe(true);
  });

  it("creates error toast", () => {
    showToast("Error occurred", "error");
    const toast = container.querySelector(".toast-error");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toBe("Error occurred");
  });

  it("removes toast after timeout", () => {
    showToast("Temporary", "success");
    expect(container.querySelector(".toast")).not.toBeNull();

    vi.advanceTimersByTime(3000);
    expect(container.querySelector(".toast")).toBeNull();
  });

  it("handles missing container gracefully", () => {
    container.remove();
    // Should not throw
    expect(() => showToast("No container", "success")).not.toThrow();
  });

  it("defaults to success type", () => {
    showToast("Default");
    const toast = container.querySelector(".toast");
    expect(toast!.classList.contains("toast-success")).toBe(true);
  });
});
