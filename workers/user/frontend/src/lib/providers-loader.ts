interface ProvidersLoadOptions {
  loading: HTMLElement;
  content: HTMLElement;
  error: HTMLElement;
  errorMessage: HTMLElement;
  retryButton: HTMLButtonElement;
  region: HTMLElement;
  focusAfterRetry: HTMLElement;
  load: () => Promise<void>;
}

/** Recover a failed provider read without repeating account-link operations. */
export function createProvidersLoader(options: ProvidersLoadOptions): () => Promise<void> {
  let pending = false;
  let loaded = false;

  async function loadProviders(isRetry = false): Promise<void> {
    if (pending || loaded) return;
    pending = true;

    const doc = options.retryButton.ownerDocument;
    const retryOwnedFocus = isRetry && doc.activeElement === options.retryButton;
    let interactedElsewhere = false;
    function recordInteraction(event: Event): void {
      if (
        event.target !== options.retryButton &&
        !options.retryButton.contains(event.target as Node)
      ) {
        interactedElsewhere = true;
      }
    }
    if (retryOwnedFocus) {
      doc.addEventListener("focusin", recordInteraction);
      doc.addEventListener("pointerdown", recordInteraction);
    }

    options.retryButton.disabled = true;
    options.region.setAttribute("aria-busy", "true");
    options.loading.style.display = "";
    options.errorMessage.textContent = "";
    // Keep the activated retry control in place while pending. The data/actions
    // stay hidden until the whole read and render succeeds.
    options.error.style.display = isRetry ? "" : "none";
    options.content.style.display = "none";

    try {
      await options.load();
      loaded = true;
      options.content.style.display = "";
    } catch (err) {
      options.errorMessage.textContent =
        err instanceof Error && err.message.trim()
          ? err.message
          : "プロバイダー一覧の取得に失敗しました";
      options.error.style.display = "";
    } finally {
      doc.removeEventListener("focusin", recordInteraction);
      doc.removeEventListener("pointerdown", recordInteraction);
      pending = false;
      options.loading.style.display = "none";
      options.region.setAttribute("aria-busy", "false");
      options.retryButton.disabled = loaded;
      if (loaded) options.error.style.display = "none";
      if (retryOwnedFocus && !interactedElsewhere) {
        (loaded ? options.focusAfterRetry : options.retryButton).focus();
      }
    }
  }

  options.retryButton.addEventListener("click", () => {
    void loadProviders(true);
  });

  return () => loadProviders();
}
