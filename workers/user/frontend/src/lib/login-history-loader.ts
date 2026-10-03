interface LoginHistoryLoadOptions<T> {
  loading: HTMLElement;
  results: HTMLElement;
  error: HTMLElement;
  errorMessage: HTMLElement;
  retryButton: HTMLButtonElement;
  empty: HTMLElement;
  list: HTMLElement;
  summary: HTMLElement;
  loadMoreWrap: HTMLElement;
  loadMoreButton: HTMLButtonElement;
  providerFilter: HTMLSelectElement;
  load: (provider: string, offset: number, signal: AbortSignal) => Promise<T[]>;
  render: (events: readonly T[]) => void;
}

export const LOGIN_HISTORY_PAGE_SIZE = 50;

/** Recover failed reads while keeping pagination scoped to the latest filter. */
export function createLoginHistoryLoader<T>(
  options: LoginHistoryLoadOptions<T>,
): () => Promise<void> {
  let requestId = 0;
  let activeRequest: AbortController | undefined;
  let pending = false;
  let offset = 0;
  let accumulated: T[] = [];
  let hasMore = true;
  let failedReset: boolean | undefined;

  async function loadPage(reset: boolean, isRetry = false, supersede = false): Promise<void> {
    if (pending && !supersede) return;
    if (!reset && !hasMore) return;
    const restoreFocus = isRetry || (!reset && document.activeElement === options.loadMoreButton);
    const id = ++requestId;
    activeRequest?.abort();
    const request = new AbortController();
    activeRequest = request;
    pending = true;
    failedReset = undefined;
    options.retryButton.disabled = true;
    options.loadMoreButton.disabled = true;
    options.loadMoreButton.textContent = "読み込み中...";
    options.error.style.display = "none";
    options.errorMessage.textContent = "";
    options.results.setAttribute("aria-busy", "true");

    if (reset) {
      offset = 0;
      accumulated = [];
      hasMore = true;
      options.list.innerHTML = "";
      options.list.style.display = "none";
      options.empty.style.display = "none";
      options.loadMoreWrap.style.display = "none";
      options.summary.textContent = "";
      options.loading.style.display = "";
    } else {
      options.summary.textContent = `${accumulated.length} 件表示中。追加の履歴を読み込み中...`;
    }

    const provider = options.providerFilter.value;
    try {
      const events = await options.load(provider, offset, request.signal);
      if (id !== requestId) return;
      if (!Array.isArray(events)) throw new Error("Invalid login history response");
      const nextEvents = accumulated.concat(events);
      // Commit the new offset only after the complete page renders successfully.
      options.render(nextEvents);
      accumulated = nextEvents;
      offset += events.length;
      hasMore = events.length === LOGIN_HISTORY_PAGE_SIZE;
      options.list.style.display = accumulated.length > 0 ? "" : "none";
      options.empty.textContent = provider
        ? `${provider} のログイン履歴はありません`
        : "ログイン履歴はありません";
      options.empty.style.display = accumulated.length === 0 ? "" : "none";
      const label = provider ? `${provider} の履歴を` : "ログイン履歴を";
      options.summary.textContent = `${label} ${accumulated.length} 件表示しています${hasMore ? "" : "。すべての履歴を読み込みました"}`;
      options.loadMoreWrap.style.display = hasMore ? "" : "none";
    } catch {
      if (id !== requestId) return;
      failedReset = reset;
      options.errorMessage.textContent = reset
        ? "ログイン履歴の取得に失敗しました。もう一度読み込んでください。"
        : "追加読み込みに失敗しました。表示中の履歴はそのままです。もう一度読み込んでください。";
      options.error.style.display = "";
      options.loadMoreWrap.style.display = "none";
      options.summary.textContent = accumulated.length > 0 ? `${accumulated.length} 件表示中` : "";
    } finally {
      if (id === requestId) {
        pending = false;
        options.loading.style.display = "none";
        options.results.setAttribute("aria-busy", "false");
        options.retryButton.disabled = failedReset === undefined;
        options.loadMoreButton.disabled = false;
        options.loadMoreButton.textContent = "もっと読み込む";
        // Don't steal focus if the user moved to the filter or another link while waiting.
        if (
          restoreFocus &&
          [options.retryButton, options.loadMoreButton, document.body].includes(
            document.activeElement as HTMLElement,
          )
        ) {
          // Re-enable before restoring focus; disabled buttons cannot receive it.
          if (failedReset !== undefined) options.retryButton.focus();
          else if (isRetry || !hasMore) options.summary.focus();
        }
      }
    }
  }

  options.providerFilter.addEventListener("change", () => {
    void loadPage(true, false, true);
  });
  options.loadMoreButton.addEventListener("click", () => {
    if (failedReset === undefined) void loadPage(false);
  });
  options.retryButton.addEventListener("click", () => {
    if (failedReset !== undefined) void loadPage(failedReset, true);
  });
  return () => loadPage(true);
}
