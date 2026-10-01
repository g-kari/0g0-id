// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createProfileLoader } from "../profile-loader";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("profile initial-load recovery", () => {
  let loading: HTMLElement;
  let content: HTMLElement;
  let error: HTMLElement;
  let errorMessage: HTMLElement;
  let retryButton: HTMLButtonElement;
  let nameInput: HTMLInputElement;
  let load: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let loadProfile: () => Promise<void>;

  beforeEach(() => {
    // Use the real page markup so changed IDs/accessibility hooks are covered.
    const page = readFileSync(
      fileURLToPath(new NodeURL("../../pages/profile.astro", import.meta.url)),
      "utf8",
    );
    document.body.innerHTML = page.split(/<Base[^>]*>/)[1].split("</Base>")[0];
    loading = document.getElementById("loading")!;
    content = document.getElementById("content")!;
    error = document.getElementById("profile-error")!;
    errorMessage = document.getElementById("profile-error-message")!;
    retryButton = document.getElementById("profile-retry-btn") as HTMLButtonElement;
    nameInput = document.getElementById("name") as HTMLInputElement;
    load = vi.fn<() => Promise<void>>().mockImplementation(async () => {
      nameInput.value = "Synthetic profile";
    });
    loadProfile = createProfileLoader({
      loading,
      content,
      error,
      errorMessage,
      retryButton,
      focusAfterRetry: nameInput,
      load,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("announces loading and exposes accessible retry/error/navigation hooks", () => {
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.textContent).toContain("プロフィールを読み込み中...");
    expect(loading.querySelector(".spinner")!.getAttribute("aria-hidden")).toBe("true");
    expect(errorMessage.getAttribute("role")).toBe("alert");
    expect(retryButton.type).toBe("button");
    expect(retryButton.textContent).toBe("もう一度読み込む");
    expect(error.querySelector("a")!.getAttribute("href")).toBe("/");
  });

  it("shows the initial profile without moving focus", async () => {
    const previousFocus = document.createElement("button");
    document.body.append(previousFocus);
    previousFocus.focus();
    await loadProfile();
    expect(load).toHaveBeenCalledOnce();
    expect(loading.style.display).toBe("none");
    expect(error.style.display).toBe("none");
    expect(content.style.display).toBe("");
    expect(nameInput.value).toBe("Synthetic profile");
    expect(document.activeElement).toBe(previousFocus);
  });

  it("keeps a failed read visible instead of auto-clearing or auto-retrying", async () => {
    vi.useFakeTimers();
    load.mockRejectedValueOnce(new Error("通信に失敗しました"));
    await loadProfile();
    await vi.advanceTimersByTimeAsync(60000);
    expect(error.style.display).toBe("");
    expect(errorMessage.textContent).toBe("通信に失敗しました");
    expect(content.style.display).toBe("none");
    expect(loading.style.display).toBe("none");
    expect(retryButton.disabled).toBe(false);
    expect(load).toHaveBeenCalledOnce();
  });

  it("recovers after an explicit retry and preserves existing account links", async () => {
    load.mockRejectedValueOnce(new Error("HTTP 503"));
    await loadProfile();
    retryButton.click();
    await vi.waitFor(() => expect(content.style.display).toBe(""));
    expect(load).toHaveBeenCalledTimes(2);
    expect(error.style.display).toBe("none");
    expect(loading.style.display).toBe("none");
    expect(nameInput.value).toBe("Synthetic profile");
    expect(document.activeElement).toBe(nameInput);
    expect(Array.from(content.querySelectorAll("a"), (a) => a.getAttribute("href"))).toEqual([
      "/sessions",
      "/connections",
      "/providers",
      "/login-history",
      "/login-stats",
    ]);
  });

  it("allows another explicit retry after a repeated failure and restores focus", async () => {
    load.mockRejectedValueOnce(new Error("first failure"));
    load.mockRejectedValueOnce(new Error("second failure"));
    await loadProfile();
    retryButton.click();
    await vi.waitFor(() => expect(errorMessage.textContent).toBe("second failure"));
    expect(retryButton.disabled).toBe(false);
    expect(document.activeElement).toBe(retryButton);
    retryButton.click();
    await vi.waitFor(() => expect(content.style.display).toBe(""));
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("blocks overlapping initial reads", async () => {
    const request = deferred();
    load.mockReturnValueOnce(request.promise);
    const firstRead = loadProfile();
    await loadProfile();
    retryButton.dispatchEvent(new MouseEvent("click"));
    expect(load).toHaveBeenCalledOnce();
    expect(retryButton.disabled).toBe(true);
    expect(loading.style.display).toBe("");
    expect(content.style.display).toBe("none");
    request.resolve();
    await firstRead;
  });

  it("blocks repeated retry clicks while a retry is pending", async () => {
    load.mockRejectedValueOnce(new Error("offline"));
    await loadProfile();
    const request = deferred();
    load.mockReturnValueOnce(request.promise);
    retryButton.click();
    retryButton.click();
    retryButton.dispatchEvent(new MouseEvent("click"));
    await loadProfile();
    expect(load).toHaveBeenCalledTimes(2);
    expect(retryButton.disabled).toBe(true);
    expect(error.style.display).toBe("none");
    expect(errorMessage.textContent).toBe("");
    expect(loading.style.display).toBe("");
    request.reject(new Error("still offline"));
    await vi.waitFor(() => expect(errorMessage.textContent).toBe("still offline"));
    expect(retryButton.disabled).toBe(false);
    expect(document.activeElement).toBe(retryButton);
  });

  it("does not re-read or overwrite unsaved input once the profile is loaded", async () => {
    await loadProfile();
    nameInput.value = "Unsaved edit";
    await loadProfile();
    retryButton.dispatchEvent(new MouseEvent("click"));
    expect(load).toHaveBeenCalledOnce();
    expect(nameInput.value).toBe("Unsaved edit");
    expect(content.style.display).toBe("");
  });

  it("renders an API error as text, never markup", async () => {
    load.mockRejectedValueOnce(new Error('<img src="x" onerror="alert(1)">'));
    await loadProfile();
    expect(errorMessage.textContent).toBe('<img src="x" onerror="alert(1)">');
    expect(errorMessage.querySelector("img")).toBeNull();
  });

  it.each([undefined, { code: "offline" }, new Error(""), new Error("   ")])(
    "uses a Japanese fallback for errors without a usable message: %s",
    async (err) => {
      load.mockRejectedValueOnce(err);
      await loadProfile();
      expect(errorMessage.textContent).toBe("プロフィールの取得に失敗しました");
      expect(error.style.display).toBe("");
      expect(retryButton.disabled).toBe(false);
    },
  );
});
