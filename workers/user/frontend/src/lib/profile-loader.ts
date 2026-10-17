interface ProfileLoadOptions {
  loading: HTMLElement;
  content: HTMLElement;
  error: HTMLElement;
  errorMessage: HTMLElement;
  retryButton: HTMLButtonElement;
  focusAfterRetry: HTMLElement;
  load: () => Promise<void>;
}

/** Keep a failed initial profile read recoverable without reloading the page. */
export function createProfileLoader(options: ProfileLoadOptions): () => Promise<void> {
  let pending = false;
  let loaded = false;

  async function loadProfile(isRetry = false): Promise<void> {
    // Only explicit retries may re-read a failed profile. Never overlap requests or
    // re-populate an already loaded form, which could overwrite unsaved edits.
    if (pending || loaded) return;
    pending = true;
    options.retryButton.disabled = true;
    options.loading.style.display = "";
    options.error.style.display = "none";
    options.errorMessage.textContent = "";
    options.content.style.display = "none";

    try {
      await options.load();
      loaded = true;
      options.content.style.display = "";
    } catch (err) {
      options.error.style.display = "";
      options.errorMessage.textContent =
        err instanceof Error && err.message.trim()
          ? err.message
          : "プロフィールの取得に失敗しました";
    } finally {
      pending = false;
      options.loading.style.display = "none";
      options.retryButton.disabled = loaded;
      if (isRetry) {
        (loaded ? options.focusAfterRetry : options.retryButton).focus();
      }
    }
  }

  options.retryButton.addEventListener("click", () => {
    void loadProfile(true);
  });

  return () => loadProfile();
}
