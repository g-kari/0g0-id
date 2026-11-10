/// <reference types="node" />
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { SOCIAL_LOGIN_BROWSER_INIT } from "./social-login-browser-init";

describe("standalone social login browser init", () => {
  it("runs without transpiler helpers and freezes the registration blocker", async () => {
    let originalCalled = false;
    const container = {
      register: async () => {
        originalCalled = true;
      },
    };
    const realm = { navigator: { serviceWorker: container }, DOMException };
    expect("__name" in realm).toBe(false);
    expect(SOCIAL_LOGIN_BROWSER_INIT).not.toContain("__name");
    runInNewContext(SOCIAL_LOGIN_BROWSER_INIT, realm);
    await expect(container.register()).rejects.toThrow(
      "Synthetic smoke blocks service worker registration",
    );
    expect(originalCalled).toBe(false);
    const descriptor = Object.getOwnPropertyDescriptor(container, "register");
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    expect(() => Object.defineProperty(container, "register", { value: () => {} })).toThrow();
  });

  it("tolerates only the opaque-origin SecurityError getter", () => {
    const navigator = Object.defineProperty({}, "serviceWorker", {
      get() {
        throw new DOMException("Opaque origin", "SecurityError");
      },
    });
    expect(() =>
      runInNewContext(SOCIAL_LOGIN_BROWSER_INIT, { navigator, DOMException }),
    ).not.toThrow();
  });

  it.each([
    new Error("Unexpected getter failure"),
    new DOMException("Other DOM failure", "NotSupportedError"),
    Object.assign(new Error("Spoofed name"), { name: "SecurityError" }),
  ])("propagates unexpected getter failure: %s", (error) => {
    const navigator = Object.defineProperty({}, "serviceWorker", {
      get() {
        throw error;
      },
    });
    let caught: unknown;
    try {
      runInNewContext(SOCIAL_LOGIN_BROWSER_INIT, { navigator, DOMException });
    } catch (value) {
      caught = value;
    }
    expect(caught).toBe(error);
  });

  it("works when the browser exposes no service worker API", () => {
    expect(() =>
      runInNewContext(SOCIAL_LOGIN_BROWSER_INIT, { navigator: {}, DOMException }),
    ).not.toThrow();
  });

  it("does not swallow failures installing the blocker", () => {
    const container = Object.freeze({ register: () => {} });
    expect(() =>
      runInNewContext(SOCIAL_LOGIN_BROWSER_INIT, {
        navigator: { serviceWorker: container },
        DOMException,
      }),
    ).toThrow();
  });
});
