// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createLoginHistoryLoader, LOGIN_HISTORY_PAGE_SIZE } from "../login-history-loader";

type Event = { id: string };
const events = (prefix: string, count = LOGIN_HISTORY_PAGE_SIZE): Event[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}` }));

function deferred(): {
  promise: Promise<Event[]>;
  resolve: (rows: Event[]) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (rows: Event[]) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Event[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("login history recovery and latest-filter pagination", () => {
  let load: ReturnType<
    typeof vi.fn<(provider: string, offset: number, signal: AbortSignal) => Promise<Event[]>>
  >;
  let start: () => Promise<void>;
  let provider: HTMLSelectElement;
  let retry: HTMLButtonElement;
  let more: HTMLButtonElement;
  let list: HTMLElement;
  let summary: HTMLElement;
  let error: HTMLElement;
  let message: HTMLElement;
  let results: HTMLElement;
  let loading: HTMLElement;
  let empty: HTMLElement;
  let moreWrap: HTMLElement;
  let render: ReturnType<typeof vi.fn<(rows: readonly Event[]) => void>>;

  beforeEach(() => {
    const page = readFileSync(
      fileURLToPath(new NodeURL("../../pages/login-history.astro", import.meta.url)),
      "utf8",
    );
    document.body.innerHTML = page.split(/<Base[^>]*>/)[1].split("</Base>")[0];
    provider = document.getElementById("provider-filter") as HTMLSelectElement;
    retry = document.getElementById("retry-btn") as HTMLButtonElement;
    more = document.getElementById("load-more-btn") as HTMLButtonElement;
    list = document.getElementById("list")!;
    summary = document.getElementById("history-summary")!;
    error = document.getElementById("error")!;
    message = document.getElementById("error-message")!;
    results = document.getElementById("history-results")!;
    loading = document.getElementById("loading")!;
    empty = document.getElementById("empty")!;
    moreWrap = document.getElementById("load-more-wrap")!;
    load = vi
      .fn<(provider: string, offset: number, signal: AbortSignal) => Promise<Event[]>>()
      .mockResolvedValue(events("all"));
    render = vi.fn<(rows: readonly Event[]) => void>().mockImplementation((rows) => {
      list.textContent = rows.map((row) => row.id).join(",");
    });
    start = createLoginHistoryLoader({
      loading,
      results,
      error,
      errorMessage: message,
      retryButton: retry,
      empty,
      list,
      summary,
      loadMoreWrap: moreWrap,
      loadMoreButton: more,
      providerFilter: provider,
      load,
      render,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function filter(value: string): void {
    provider.value = value;
    provider.dispatchEvent(new Event("change"));
  }

  it("exposes named keyboard controls and loading/error/result announcements", () => {
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.querySelector(".spinner")!.getAttribute("aria-hidden")).toBe("true");
    expect(message.getAttribute("role")).toBe("alert");
    expect(summary.getAttribute("role")).toBe("status");
    expect(summary.tabIndex).toBe(-1);
    expect(retry.type).toBe("button");
    expect(more.type).toBe("button");
    expect(document.querySelector('label[for="provider-filter"]')).not.toBeNull();
    expect(document.querySelector('a[href="/profile"]')).not.toBeNull();
  });

  it("keeps the initial failure recoverable without an automatic retry", async () => {
    vi.useFakeTimers();
    load.mockRejectedValueOnce(new Error("offline"));
    await start();
    await vi.advanceTimersByTimeAsync(60000);
    expect(load).toHaveBeenCalledOnce();
    expect(error.style.display).toBe("");
    expect(message.textContent).toContain("ログイン履歴の取得に失敗");
    expect(retry.disabled).toBe(false);
    expect(results.getAttribute("aria-busy")).toBe("false");
    expect(empty.style.display).toBe("none");
  });

  it("deduplicates initial and explicit retry requests and recovers with focus", async () => {
    const initial = deferred();
    load.mockReturnValueOnce(initial.promise);
    const first = start();
    await start();
    retry.dispatchEvent(new MouseEvent("click"));
    more.dispatchEvent(new MouseEvent("click"));
    expect(load).toHaveBeenCalledOnce();
    initial.reject(new Error("offline"));
    await first;
    const second = deferred();
    load.mockReturnValueOnce(second.promise);
    retry.click();
    retry.dispatchEvent(new MouseEvent("click"));
    expect(load).toHaveBeenCalledTimes(2);
    expect(retry.disabled).toBe(true);
    second.resolve(events("recovered", 1));
    await vi.waitFor(() => expect(list.textContent).toBe("recovered-0"));
    expect(error.style.display).toBe("none");
    expect(document.activeElement).toBe(summary);
    expect(summary.textContent).toContain("すべての履歴を読み込みました");
  });

  it("allows repeated failures and restores keyboard focus to retry", async () => {
    load.mockRejectedValueOnce(new Error("first")).mockRejectedValueOnce(new Error("second"));
    await start();
    retry.click();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(retry.disabled).toBe(false));
    expect(document.activeElement).toBe(retry);
    retry.click();
    await vi.waitFor(() => expect(list.textContent).toContain("all-0"));
    expect(load.mock.calls.map((call) => call[1])).toEqual([0, 0, 0]);
  });

  it("preserves loaded rows and retries the same offset after page failure", async () => {
    await start();
    const original = list.textContent;
    load.mockRejectedValueOnce(new Error("page failure"));
    more.click();
    await vi.waitFor(() => expect(error.style.display).toBe(""));
    expect(list.textContent).toBe(original);
    expect(list.style.display).toBe("");
    expect(summary.textContent).toBe("50 件表示中");
    expect(message.textContent).toContain("表示中の履歴はそのまま");
    more.dispatchEvent(new MouseEvent("click"));
    expect(load).toHaveBeenCalledTimes(2);
    load.mockResolvedValueOnce(events("next", 2));
    retry.click();
    await vi.waitFor(() => expect(summary.textContent).toContain("52 件"));
    expect(load.mock.calls.map((call) => call[1])).toEqual([0, 50, 50]);
    expect(list.textContent).toContain("all-0");
    expect(list.textContent).toContain("next-1");
    expect(error.style.display).toBe("none");
    expect(moreWrap.style.display).toBe("none");
  });

  it("guards repeated load-more clicks and stops at the last page", async () => {
    await start();
    const next = deferred();
    load.mockReturnValueOnce(next.promise);
    more.click();
    more.dispatchEvent(new MouseEvent("click"));
    more.dispatchEvent(new MouseEvent("click"));
    expect(load).toHaveBeenCalledTimes(2);
    expect(more.disabled).toBe(true);
    expect(results.getAttribute("aria-busy")).toBe("true");
    next.resolve(events("next", 1));
    await vi.waitFor(() => expect(results.getAttribute("aria-busy")).toBe("false"));
    more.dispatchEvent(new MouseEvent("click"));
    expect(load).toHaveBeenCalledTimes(2);
    expect(summary.textContent).toContain("51 件");
  });

  it("ignores stale successes even if the transport does not honor cancellation", async () => {
    const old = deferred();
    load.mockReturnValueOnce(old.promise);
    const initial = start();
    load.mockResolvedValueOnce(events("github", 1));
    filter("github");
    await vi.waitFor(() => expect(list.textContent).toBe("github-0"));
    expect(load.mock.calls[0][2].aborted).toBe(true);
    old.resolve(events("old"));
    await initial;
    expect(list.textContent).toBe("github-0");
    expect(summary.textContent).toContain("github の履歴を 1 件");
    expect(moreWrap.style.display).toBe("none");
  });

  it("ignores stale failures while the current filter is loading", async () => {
    const old = deferred();
    const current = deferred();
    load.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const initial = start();
    filter("line");
    old.reject(new Error("stale failure"));
    await initial;
    expect(error.style.display).toBe("none");
    expect(loading.style.display).toBe("");
    expect(results.getAttribute("aria-busy")).toBe("true");
    current.resolve([]);
    await vi.waitFor(() => expect(empty.style.display).toBe(""));
    expect(empty.textContent).toBe("line のログイン履歴はありません");
    expect(summary.textContent).toContain("0 件");
  });

  it("discards an older appended page when a provider changes and resets offset", async () => {
    await start();
    const append = deferred();
    load.mockReturnValueOnce(append.promise).mockResolvedValueOnce(events("x"));
    more.click();
    filter("x");
    await vi.waitFor(() => expect(list.textContent).toContain("x-0"));
    append.resolve(events("wrong"));
    await Promise.resolve();
    expect(list.textContent).not.toContain("wrong");
    expect(load.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["", 0],
      ["", 50],
      ["x", 0],
    ]);
    load.mockResolvedValueOnce([]);
    more.click();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(4));
    expect(load.mock.calls[3].slice(0, 2)).toEqual(["x", 50]);
  });

  it("uses the latest provider on retry and never displays a false empty state on errors", async () => {
    await start();
    load.mockRejectedValueOnce(new Error("<img src=x onerror=alert(1)>"));
    filter("twitch");
    await vi.waitFor(() => expect(error.style.display).toBe(""));
    expect(list.textContent).toBe("");
    expect(empty.style.display).toBe("none");
    expect(message.querySelector("img")).toBeNull();
    load.mockResolvedValueOnce(events("twitch", 1));
    retry.click();
    await vi.waitFor(() => expect(list.textContent).toBe("twitch-0"));
    expect(load.mock.calls[2].slice(0, 2)).toEqual(["twitch", 0]);
  });

  it("makes a malformed response recoverable", async () => {
    load.mockResolvedValueOnce(null as unknown as Event[]);
    await start();
    expect(error.style.display).toBe("");
    expect(retry.disabled).toBe(false);
    expect(empty.style.display).toBe("none");
    expect(results.getAttribute("aria-busy")).toBe("false");
  });
  it("does not steal focus when the user tabs to a different control during retry", async () => {
    load.mockRejectedValueOnce(new Error("offline"));
    await start();
    const pendingRetry = deferred();
    load.mockReturnValueOnce(pendingRetry.promise);
    retry.focus();
    retry.click();
    provider.focus();
    pendingRetry.resolve(events("recovered", 1));
    await vi.waitFor(() => expect(error.style.display).toBe("none"));
    await vi.waitFor(() => expect(results.getAttribute("aria-busy")).toBe("false"));
    expect(document.activeElement).toBe(provider);
  });

  it("offers a focused retry when a keyboard load-more request fails", async () => {
    await start();
    load.mockRejectedValueOnce(new Error("offline"));
    more.focus();
    more.click();
    await vi.waitFor(() => expect(error.style.display).toBe(""));
    expect(document.activeElement).toBe(retry);
  });

  it("preserves the last committed offset and rows when rendering a page fails", async () => {
    await start();
    const original = list.textContent;
    render.mockImplementationOnce(() => {
      throw new Error("Malformed row");
    });
    load.mockResolvedValueOnce(events("bad", 1));
    more.click();
    await vi.waitFor(() => expect(error.style.display).toBe(""));
    expect(list.textContent).toBe(original);
    expect(summary.textContent).toBe("50 件表示中");
    load.mockResolvedValueOnce(events("valid", 1));
    retry.click();
    await vi.waitFor(() => expect(summary.textContent).toContain("51 件"));
    expect(load.mock.calls.map((call) => call[1])).toEqual([0, 50, 50]);
    expect(list.textContent).not.toContain("bad");
    expect(list.textContent).toContain("valid");
  });
});
