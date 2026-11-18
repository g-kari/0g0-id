/**
 * Static browser JavaScript, not a serialized TS callback: tsx/esbuild may add
 * closure helpers such as __name that do not exist in the browser realm.
 * The smoke uses an explicit registration blocker because opaque-origin documents
 * may throw SecurityError when code reads navigator.serviceWorker.
 */
export const SOCIAL_LOGIN_BROWSER_INIT = `(() => {
  let container;
  try {
    container = navigator.serviceWorker;
  } catch (error) {
    if (error instanceof DOMException && error.name === "SecurityError") return;
    throw error;
  }
  if (container) {
    Object.defineProperty(container, "register", {
      configurable: false,
      writable: false,
      value: async () => {
        throw new Error("Synthetic smoke blocks service worker registration");
      },
    });
  }
})();`;
