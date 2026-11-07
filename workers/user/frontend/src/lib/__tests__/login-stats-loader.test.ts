// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DailyLoginStat, LoginProviderStat } from "@0g0-id/api-types";
import { createLoginStatsLoader } from "../login-stats-loader";
import type { LoginStatsData, LoginStatsLoader, LoginStatsPeriod } from "../login-stats-loader";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: () => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const item: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value: T): void => {
      item.settled = true;
      resolve(value);
    },
    reject: (): void => {
      item.settled = true;
      reject(new Error("synthetic endpoint failure"));
    },
  };
  return item;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

interface RequestPair {
  days: LoginStatsPeriod;
  ordinal: number;
  providers: Deferred<LoginProviderStat[]>;
  trends: Deferred<DailyLoginStat[]>;
}

type EndpointOutcome = "data" | "empty" | "failure";

describe("login stats paired-view ownership and recovery", () => {
  let daysSelect: HTMLSelectElement;
  let loading: HTMLElement;
  let error: HTMLElement;
  let errorMessage: HTMLElement;
  let empty: HTMLElement;
  let providersCard: HTMLElement;
  let trendsCard: HTMLElement;
  let retryButton: HTMLButtonElement;
  let controller: LoginStatsLoader;
  let requests: RequestPair[];
  let render: ReturnType<typeof vi.fn<(data: LoginStatsData, days: LoginStatsPeriod) => void>>;

  beforeEach(() => {
    const page = readFileSync(
      fileURLToPath(new NodeURL("../../pages/login-stats.astro", import.meta.url)),
      "utf8",
    );
    document.body.innerHTML = page.split(/<Base[^>]*>/)[1].split("</Base>")[0];
    daysSelect = document.getElementById("days-select") as HTMLSelectElement;
    loading = document.getElementById("loading")!;
    error = document.getElementById("error")!;
    errorMessage = document.getElementById("stats-error-message")!;
    empty = document.getElementById("empty")!;
    providersCard = document.getElementById("providers-card")!;
    trendsCard = document.getElementById("trends-card")!;
    retryButton = document.getElementById("stats-retry-btn") as HTMLButtonElement;
    requests = [];
    // The real page renderer is exercised by the built-browser smoke. This renderer
    // records whether obsolete pairs can publish any content before visibility changes.
    render = vi.fn((data: LoginStatsData, days: LoginStatsPeriod): void => {
      document.getElementById("total-count")!.textContent = String(
        data.providers.reduce((sum, item) => sum + item.count, 0),
      );
      document.getElementById("top-provider")!.textContent = data.providers[0]?.provider ?? "-";
      document.getElementById("providers-list")!.textContent = JSON.stringify(data.providers);
      document.getElementById("trends-title")!.textContent = `直近 ${days}日のトレンド`;
      document.getElementById("trends-list")!.textContent = JSON.stringify(data.trends);
      document.getElementById("trends-empty")!.style.display = data.trends.length ? "none" : "";
    });
    controller = createLoginStatsLoader({
      daysSelect,
      loading,
      error,
      errorMessage,
      empty,
      providersCard,
      trendsCard,
      retryButton,
      read: (days: LoginStatsPeriod): Promise<LoginStatsData> => {
        const request: RequestPair = {
          days,
          ordinal: requests.length + 1,
          providers: deferred<LoginProviderStat[]>(),
          trends: deferred<DailyLoginStat[]>(),
        };
        requests.push(request);
        return Promise.all([request.providers.promise, request.trends.promise]).then(
          ([providers, trends]): LoginStatsData => ({ providers, trends }),
        );
      },
      render,
    });
  });

  afterEach(async () => {
    for (const request of requests) {
      if (!request.providers.settled) request.providers.resolve([]);
      if (!request.trends.settled) request.trends.resolve([]);
    }
    await flush();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function start(days: LoginStatsPeriod): Promise<void> {
    daysSelect.value = String(days);
    return controller.load();
  }

  function providersFor(request: RequestPair): LoginProviderStat[] {
    return [
      {
        provider: `request-${request.ordinal}-${request.days}`,
        count: request.ordinal * 100 + request.days,
      },
    ];
  }

  function trendsFor(request: RequestPair): DailyLoginStat[] {
    return [{ date: "2026-10-05", count: request.ordinal * 100 + request.days }];
  }

  function settle(
    request: RequestPair,
    providers: EndpointOutcome = "data",
    trends: EndpointOutcome = "data",
  ): void {
    if (providers === "failure") request.providers.reject();
    else request.providers.resolve(providers === "empty" ? [] : providersFor(request));
    if (trends === "failure") request.trends.reject();
    else request.trends.resolve(trends === "empty" ? [] : trendsFor(request));
  }

  function snapshot(): { html: string; selected: string; active: string; renders: number } {
    return {
      html: document.body.innerHTML,
      selected: daysSelect.value,
      active: document.activeElement?.id ?? "",
      renders: render.mock.calls.length,
    };
  }

  it("has labelled native controls and accessible loading/error announcements", () => {
    expect(document.querySelector('label[for="days-select"]')).not.toBeNull();
    expect(Array.from(daysSelect.options, (option) => option.value)).toEqual([
      "7",
      "30",
      "90",
      "365",
    ]);
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.getAttribute("aria-live")).toBe("polite");
    expect(loading.querySelector(".spinner")!.getAttribute("aria-hidden")).toBe("true");
    expect(errorMessage.getAttribute("role")).toBe("alert");
    expect(retryButton.type).toBe("button");
    expect(retryButton.textContent).toBe("もう一度読み込む");
    expect(document.querySelector('a[href="/profile"]')).not.toBeNull();
  });

  for (const days of [7, 30, 90, 365] as const) {
    it(`loads and atomically publishes ${days} days`, async () => {
      const task = start(days);
      expect(requests).toHaveLength(1);
      expect(requests[0].days).toBe(days);
      expect(loading.style.display).toBe("");
      expect(error.style.display).toBe("none");
      expect(empty.style.display).toBe("none");
      expect(retryButton.disabled).toBe(true);
      settle(requests[0]);
      await task;
      expect(render).toHaveBeenCalledExactlyOnceWith(
        { providers: providersFor(requests[0]), trends: trendsFor(requests[0]) },
        days,
      );
      expect(loading.style.display).toBe("none");
      expect(providersCard.style.display).toBe("");
      expect(trendsCard.style.display).toBe("");
      expect(document.getElementById("trends-title")!.textContent).toBe(`直近 ${days}日のトレンド`);
    });
  }

  for (const stale of ["data", "empty", "failure"] as const) {
    for (const timing of ["before", "after"] as const) {
      it(`ignores stale ${stale} ${timing} the latest 90-day success`, async () => {
        const first = start(7),
          latest = start(90);
        if (timing === "after") {
          settle(requests[1]);
          await latest;
        }
        const current = snapshot();
        settle(requests[0], stale, stale);
        await first;
        expect(snapshot()).toEqual(current);
        if (timing === "before") {
          expect(loading.style.display).toBe("");
          expect(retryButton.disabled).toBe(true);
          settle(requests[1]);
          await latest;
        }
        expect(document.getElementById("top-provider")!.textContent).toBe("request-2-90");
        expect(error.style.display).toBe("none");
        expect(empty.style.display).toBe("none");
      });
    }
  }

  it("distinguishes generations in 7 to 90 to 7 even when transports ignore supersession", async () => {
    const first = start(7),
      middle = start(90),
      latest = start(7);
    settle(requests[2]);
    await latest;
    const current = snapshot();
    settle(requests[0]);
    await first;
    expect(snapshot()).toEqual(current);
    settle(requests[1], "failure", "data");
    await middle;
    expect(snapshot()).toEqual(current);
    expect(document.getElementById("top-provider")!.textContent).toBe("request-3-7");
  });

  for (const newest of ["empty", "failure"] as const) {
    it(`keeps latest ${newest} authoritative after an older success`, async () => {
      const first = start(7),
        latest = start(90);
      settle(requests[1], newest, newest);
      await latest;
      const current = snapshot();
      settle(requests[0]);
      await first;
      expect(snapshot()).toEqual(current);
      expect(providersCard.style.display).toBe("none");
      expect(trendsCard.style.display).toBe("none");
      expect(newest === "empty" ? empty.style.display : error.style.display).toBe("");
    });
  }

  for (const providers of ["data", "empty", "failure"] as const) {
    for (const trends of ["data", "empty", "failure"] as const) {
      it(`handles providers=${providers} and trends=${trends} as one pair`, async () => {
        const task = start(90);
        settle(requests[0], providers, trends);
        await task;
        const failed = providers === "failure" || trends === "failure";
        const bothEmpty = providers === "empty" && trends === "empty";
        expect(loading.style.display).toBe("none");
        expect(error.style.display).toBe(failed ? "" : "none");
        expect(errorMessage.textContent).toBe(failed ? "ログイン統計の取得に失敗しました" : "");
        expect(empty.style.display).toBe(!failed && bothEmpty ? "" : "none");
        expect(providersCard.style.display).toBe(!failed && !bothEmpty ? "" : "none");
        expect(trendsCard.style.display).toBe(providersCard.style.display);
        expect(retryButton.disabled).toBe(!failed);
        expect(render).toHaveBeenCalledTimes(!failed && !bothEmpty ? 1 : 0);
      });
    }
  }

  for (const first of ["providers", "trends"] as const) {
    it(`does not publish a partial pair when ${first} succeeds first`, async () => {
      const task = start(90);
      if (first === "providers") requests[0].providers.resolve(providersFor(requests[0]));
      else requests[0].trends.resolve(trendsFor(requests[0]));
      await flush();
      expect(render).not.toHaveBeenCalled();
      expect(loading.style.display).toBe("");
      if (first === "providers") requests[0].trends.resolve(trendsFor(requests[0]));
      else requests[0].providers.resolve(providersFor(requests[0]));
      await task;
      expect(render).toHaveBeenCalledOnce();
    });

    it(`can retry after ${first} fails while its sibling is still pending`, async () => {
      const task = start(90);
      requests[0][first].reject();
      await task;
      expect(error.style.display).toBe("");
      expect(retryButton.disabled).toBe(false);
      const retry = controller.retry();
      settle(requests[1]);
      await retry;
      const current = snapshot();
      if (first === "providers") requests[0].trends.resolve(trendsFor(requests[0]));
      else requests[0].providers.resolve(providersFor(requests[0]));
      await flush();
      expect(snapshot()).toEqual(current);
    });
  }

  it("keeps initial failure visible without automatic clearing or retry", async () => {
    vi.useFakeTimers();
    const task = start(30);
    settle(requests[0], "failure", "data");
    await task;
    await vi.advanceTimersByTimeAsync(60000);
    expect(requests).toHaveLength(1);
    expect(error.style.display).toBe("");
    expect(errorMessage.textContent).toBe("ログイン統計の取得に失敗しました");
  });

  it("supports repeated same-period failures then success and deduplicates pending retry", async () => {
    const task = start(90);
    settle(requests[0], "failure", "data");
    await task;
    const retry = controller.retry();
    await controller.retry();
    await controller.load();
    expect(requests).toHaveLength(2);
    expect(retryButton.disabled).toBe(true);
    settle(requests[1], "data", "failure");
    await retry;
    expect(retryButton.disabled).toBe(false);
    const recovery = controller.retry();
    settle(requests[2]);
    await recovery;
    expect(requests.map((request) => request.days)).toEqual([90, 90, 90]);
    expect(error.style.display).toBe("none");
    expect(errorMessage.textContent).toBe("");
    expect(document.getElementById("top-provider")!.textContent).toBe("request-3-90");
  });

  it("allows a period change to supersede a pending retry", async () => {
    const task = start(7);
    settle(requests[0], "failure", "data");
    await task;
    const retry = controller.retry(),
      latest = start(90);
    settle(requests[2]);
    await latest;
    const current = snapshot();
    settle(requests[1], "failure", "empty");
    await retry;
    expect(snapshot()).toEqual(current);
    expect(daysSelect.disabled).toBe(false);
  });

  for (const outcome of ["data", "empty"] as const) {
    it(`ignores hidden Retry after latest ${outcome}`, async () => {
      const task = start(30);
      settle(requests[0], outcome, outcome);
      await task;
      await controller.retry();
      expect(requests).toHaveLength(1);
    });
  }

  it("reconciles a restored selector without duplicating unchanged pageshow reads", async () => {
    const task = start(30);
    await controller.reconcile();
    expect(requests).toHaveLength(1);
    daysSelect.value = "90";
    const restored = controller.reconcile();
    expect(requests.map((request) => request.days)).toEqual([30, 90]);
    await controller.reconcile();
    expect(requests).toHaveLength(2);
    settle(requests[1]);
    await restored;
    const current = snapshot();
    settle(requests[0]);
    await task;
    expect(snapshot()).toEqual(current);
    await controller.reconcile();
    expect(requests).toHaveLength(2);
  });

  for (const outcome of ["data", "failure"] as const) {
    it(`rechecks a selector changed without an event before committing ${outcome}`, async () => {
      const task = start(30);
      daysSelect.value = "365";
      settle(requests[0], outcome, outcome);
      await flush();
      expect(requests.map((request) => request.days)).toEqual([30, 365]);
      expect(render).not.toHaveBeenCalled();
      expect(error.style.display).toBe("none");
      expect(loading.style.display).toBe("");
      settle(requests[1]);
      await task;
      expect(document.getElementById("trends-title")!.textContent).toBe("直近 365日のトレンド");
    });
  }

  it("does not automatically retry an unchanged restored failed period", async () => {
    const task = start(90);
    settle(requests[0], "failure", "data");
    await task;
    await controller.reconcile();
    expect(requests).toHaveLength(1);
    expect(error.style.display).toBe("");
  });

  it("contains a rendering failure and permits a later recovery", async () => {
    render.mockImplementationOnce((): void => {
      document.getElementById("total-count")!.textContent = "partially written";
      throw new Error("synthetic rendering failure");
    });
    const task = start(90);
    settle(requests[0]);
    await task;
    expect(error.style.display).toBe("");
    expect(providersCard.style.display).toBe("none");
    expect(trendsCard.style.display).toBe("none");
    expect(retryButton.disabled).toBe(false);
    const retry = controller.retry();
    settle(requests[1]);
    await retry;
    expect(error.style.display).toBe("none");
    expect(providersCard.style.display).toBe("");
    expect(document.getElementById("total-count")!.textContent).toBe("290");
  });

  it("does not steal focus during initial load, retry, period change or stale completion", async () => {
    const link = document.querySelector('a[href="/profile"]') as HTMLAnchorElement;
    link.focus();
    const task = start(30);
    settle(requests[0], "failure", "data");
    await task;
    expect(document.activeElement).toBe(link);
    retryButton.focus();
    const retry = controller.retry();
    daysSelect.focus();
    const latest = start(90);
    settle(requests[2]);
    await latest;
    expect(document.activeElement).toBe(daysSelect);
    settle(requests[1]);
    await retry;
    expect(document.activeElement).toBe(daysSelect);
  });
});
