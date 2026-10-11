// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createProvidersLoader } from "../providers-loader";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("provider initial-read recovery", () => {
  let loading: HTMLElement;
  let content: HTMLElement;
  let error: HTMLElement;
  let errorMessage: HTMLElement;
  let retryButton: HTMLButtonElement;
  let region: HTMLElement;
  let heading: HTMLElement;
  let back: HTMLAnchorElement;
  let load: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let loadProviders: () => Promise<void>;

  beforeEach(() => {
    const page = readFileSync(
      fileURLToPath(new NodeURL("../../pages/providers.astro", import.meta.url)),
      "utf8",
    );
    document.body.innerHTML = page.split(/<Base[^>]*>/)[1].split("</Base>")[0];
    loading = document.getElementById("loading")!;
    content = document.getElementById("provider-content")!;
    error = document.getElementById("providers-error")!;
    errorMessage = document.getElementById("providers-error-message")!;
    retryButton = document.getElementById("providers-retry-btn") as HTMLButtonElement;
    region = document.getElementById("providers-state")!;
    heading = document.getElementById("providers-heading")!;
    back = document.querySelector('a[href="/profile"]')!;
    load = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    loadProviders = createProvidersLoader({
      loading,
      content,
      error,
      errorMessage,
      retryButton,
      region,
      focusAfterRetry: heading,
      load,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("keeps the page title and profile escape outside hidden provider actions", () => {
    expect(document.getElementById("content")!.style.display).toBe("");
    expect(content.contains(heading)).toBe(false);
    expect(content.contains(back)).toBe(false);
    expect(heading.textContent).toBe("SNS連携");
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.querySelector(".spinner")!.getAttribute("aria-hidden")).toBe("true");
    expect(errorMessage.getAttribute("role")).toBe("alert");
    expect(retryButton.type).toBe("button");
    expect(retryButton.textContent).toBe("もう一度読み込む");
    expect(content.style.display).toBe("none");
  });

  it("shows initial success without moving focus", async () => {
    back.focus();
    await loadProviders();
    expect(content.style.display).toBe("");
    expect(loading.style.display).toBe("none");
    expect(error.style.display).toBe("none");
    expect(region.getAttribute("aria-busy")).toBe("false");
    expect(document.activeElement).toBe(back);
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps failure visible beyond the old toast lifetime without auto retries", async () => {
    vi.useFakeTimers();
    load.mockRejectedValueOnce(new Error("一時的なエラーです"));
    await loadProviders();
    await vi.advanceTimersByTimeAsync(60000);
    expect(error.style.display).toBe("");
    expect(errorMessage.textContent).toBe("一時的なエラーです");
    expect(content.style.display).toBe("none");
    expect(loading.style.display).toBe("none");
    expect(region.getAttribute("aria-busy")).toBe("false");
    expect(retryButton.disabled).toBe(false);
    expect(document.getElementById("content")!.style.display).toBe("");
    expect(load).toHaveBeenCalledOnce();
  });

  it.each([undefined, "", new Error("  ")])(
    "uses a useful fallback for a missing error",
    async (err) => {
      load.mockRejectedValueOnce(err);
      await loadProviders();
      expect(errorMessage.textContent).toBe("プロバイダー一覧の取得に失敗しました");
      expect(retryButton.disabled).toBe(false);
    },
  );

  it("renders error text literally", async () => {
    load.mockRejectedValueOnce(new Error('<img src=x onerror="alert(1)">'));
    await loadProviders();
    expect(errorMessage.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(errorMessage.children).toHaveLength(0);
  });

  it("deduplicates repeated activations while the explicit retry is pending", async () => {
    const gate = deferred();
    load.mockRejectedValueOnce(new Error("失敗")).mockReturnValueOnce(gate.promise);
    await loadProviders();
    retryButton.focus();
    retryButton.click();
    retryButton.dispatchEvent(new MouseEvent("click"));
    retryButton.dispatchEvent(new MouseEvent("click"));
    await loadProviders();
    expect(load).toHaveBeenCalledTimes(2);
    expect(retryButton.disabled).toBe(true);
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(content.style.display).toBe("none");
    expect(loading.style.display).toBe("");
    expect(error.style.display).toBe("");
    gate.resolve();
    await vi.waitFor(() => expect(content.style.display).toBe(""));
    expect(error.style.display).toBe("none");
    expect(document.activeElement).toBe(heading);
  });

  it("allows repeated failures and then explicit recovery", async () => {
    load
      .mockRejectedValueOnce(new Error("初回失敗"))
      .mockRejectedValueOnce(new Error("再度失敗"))
      .mockResolvedValueOnce(undefined);
    await loadProviders();
    retryButton.focus();
    retryButton.click();
    await vi.waitFor(() => expect(errorMessage.textContent).toBe("再度失敗"));
    expect(document.activeElement).toBe(retryButton);
    expect(retryButton.disabled).toBe(false);
    retryButton.click();
    await vi.waitFor(() => expect(content.style.display).toBe(""));
    expect(errorMessage.textContent).toBe("");
    expect(error.style.display).toBe("none");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("keeps a partial render hidden when rendering fails", async () => {
    load.mockImplementationOnce(async () => {
      content.innerHTML = '<button data-unlink="google">Partial synthetic action</button>';
      throw new Error("描画失敗");
    });
    await loadProviders();
    expect(content.style.display).toBe("none");
    expect(errorMessage.textContent).toBe("描画失敗");
    retryButton.click();
    await vi.waitFor(() => expect(content.style.display).toBe(""));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not read again after success or restore stale provider statuses", async () => {
    await loadProviders();
    content.textContent = "Updated locally by the existing unlink handler";
    retryButton.dispatchEvent(new MouseEvent("click"));
    await loadProviders();
    expect(load).toHaveBeenCalledOnce();
    expect(content.textContent).toBe("Updated locally by the existing unlink handler");
  });

  it.each(["success", "failure"])(
    "preserves focus moved elsewhere during a retry: %s",
    async (outcome) => {
      const gate = deferred();
      load.mockRejectedValueOnce(new Error("失敗")).mockReturnValueOnce(gate.promise);
      await loadProviders();
      retryButton.focus();
      retryButton.click();
      back.focus();
      if (outcome === "success") gate.resolve();
      else gate.reject(new Error("再失敗"));
      await vi.waitFor(() => expect(region.getAttribute("aria-busy")).toBe("false"));
      expect(document.activeElement).toBe(back);
    },
  );

  it("does not claim focus after a pointer interaction elsewhere", async () => {
    const gate = deferred();
    load.mockRejectedValueOnce(new Error("失敗")).mockReturnValueOnce(gate.promise);
    await loadProviders();
    retryButton.focus();
    retryButton.click();
    heading.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    gate.resolve();
    await vi.waitFor(() => expect(content.style.display).toBe(""));
    expect(document.activeElement).not.toBe(heading);
  });

  it("does not move focus for a programmatic retry", async () => {
    load.mockRejectedValueOnce(new Error("失敗")).mockResolvedValueOnce(undefined);
    await loadProviders();
    back.focus();
    retryButton.dispatchEvent(new MouseEvent("click"));
    await vi.waitFor(() => expect(content.style.display).toBe(""));
    expect(document.activeElement).toBe(back);
  });
});
