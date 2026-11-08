import type { DailyLoginStat, LoginProviderStat } from "@0g0-id/api-types";

export type LoginStatsPeriod = 7 | 30 | 90 | 365;

export interface LoginStatsData {
  providers: LoginProviderStat[];
  trends: DailyLoginStat[];
}

type LoginStatsState =
  | { kind: "loading"; requestId: number; days: LoginStatsPeriod }
  | { kind: "ready"; requestId: number; days: LoginStatsPeriod }
  | { kind: "empty"; requestId: number; days: LoginStatsPeriod }
  | { kind: "error"; requestId: number; days: LoginStatsPeriod };

type Visibility = {
  [Kind in LoginStatsState["kind"]]: {
    loading: Kind extends "loading" ? true : false;
    error: Kind extends "error" ? true : false;
    empty: Kind extends "empty" ? true : false;
    cards: Kind extends "ready" ? true : false;
  };
};

const visibility = {
  loading: { loading: true, error: false, empty: false, cards: false },
  ready: { loading: false, error: false, empty: false, cards: true },
  empty: { loading: false, error: false, empty: true, cards: false },
  error: { loading: false, error: true, empty: false, cards: false },
} satisfies Visibility;

interface LoginStatsLoaderOptions {
  daysSelect: HTMLSelectElement;
  loading: HTMLElement;
  error: HTMLElement;
  errorMessage: HTMLElement;
  empty: HTMLElement;
  providersCard: HTMLElement;
  trendsCard: HTMLElement;
  retryButton: HTMLButtonElement;
  read: (days: LoginStatsPeriod) => Promise<LoginStatsData>;
  render: (data: LoginStatsData, days: LoginStatsPeriod) => void;
}

export interface LoginStatsLoader {
  load: () => Promise<void>;
  retry: () => Promise<void>;
  reconcile: () => Promise<void>;
}

function selectedPeriod(value: string): LoginStatsPeriod {
  const days = Number(value);
  return days === 7 || days === 90 || days === 365 ? days : 30;
}

/** Own the entire paired stats view with one request generation. */
export function createLoginStatsLoader(options: LoginStatsLoaderOptions): LoginStatsLoader {
  let generation = 0;
  let state: LoginStatsState | null = null;
  let stopFocusTracking: (() => void) | undefined;
  const ownerDocument = options.retryButton.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;

  function display(next: LoginStatsState): void {
    state = next;
    const flags = visibility[next.kind];
    options.loading.style.display = flags.loading ? "" : "none";
    options.error.style.display = flags.error ? "" : "none";
    options.errorMessage.textContent = flags.error ? "ログイン統計の取得に失敗しました" : "";
    options.empty.style.display = flags.empty ? "" : "none";
    options.providersCard.style.display = flags.cards ? "" : "none";
    options.trendsCard.style.display = flags.cards ? "" : "none";
    options.retryButton.disabled = !flags.error;
  }

  async function load(isRetry = false): Promise<void> {
    const days = selectedPeriod(options.daysSelect.value);
    if (state?.kind === "loading" && state.days === days) return;
    stopFocusTracking?.();
    const requestId = ++generation;
    let restoreRetryFocus = isRetry && ownerDocument.activeElement === options.retryButton;
    display({ kind: "loading", requestId, days });

    // Start after hiding/disabling Retry: its own focus loss is not user intent.
    const cancelFocus = (): void => {
      restoreRetryFocus = false;
    };
    const onFocus = (event: FocusEvent): void => {
      if (event.target !== options.retryButton) cancelFocus();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Tab" || event.key === "Escape") cancelFocus();
    };
    const cleanupFocus = (): void => {
      ownerDocument.removeEventListener("focusin", onFocus, true);
      ownerDocument.removeEventListener("pointerdown", cancelFocus, true);
      ownerDocument.removeEventListener("keydown", onKey, true);
      ownerWindow?.removeEventListener("blur", cancelFocus);
      ownerWindow?.removeEventListener("pagehide", cancelFocus);
      if (stopFocusTracking === cleanupFocus) stopFocusTracking = undefined;
    };
    if (restoreRetryFocus) {
      ownerDocument.addEventListener("focusin", onFocus, true);
      ownerDocument.addEventListener("pointerdown", cancelFocus, true);
      ownerDocument.addEventListener("keydown", onKey, true);
      ownerWindow?.addEventListener("blur", cancelFocus);
      ownerWindow?.addEventListener("pagehide", cancelFocus);
      stopFocusTracking = cleanupFocus;
    }

    try {
      // Reading must not mutate the UI: neither endpoint can publish a partial pair.
      const data = await options.read(days);
      if (requestId !== generation) return;
      if (selectedPeriod(options.daysSelect.value) !== days) {
        await load();
        return;
      }
      if (data.providers.length === 0 && data.trends.length === 0) {
        display({ kind: "empty", requestId, days });
        return;
      }
      options.render(data, days);
      display({ kind: "ready", requestId, days });
    } catch {
      if (requestId !== generation) return;
      if (selectedPeriod(options.daysSelect.value) !== days) {
        await load();
        return;
      }
      // Includes render failures; any partially written cards remain hidden.
      display({ kind: "error", requestId, days });
      if (
        restoreRetryFocus &&
        (ownerDocument.activeElement === ownerDocument.body ||
          ownerDocument.activeElement === options.retryButton)
      ) {
        options.retryButton.focus();
      }
    } finally {
      cleanupFocus();
    }
  }

  return {
    load,
    retry: async (): Promise<void> => {
      if (state?.kind === "error") await load(true);
    },
    reconcile: async (): Promise<void> => {
      if (state !== null && state.days !== selectedPeriod(options.daysSelect.value)) await load();
    },
  };
}
