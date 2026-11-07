/// <reference types="node" />
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import { nativePasskeyPage } from "./native-passkey-page";

// Execute the exact emitted JavaScript against a small DOM/WebAuthn test double.
// This covers page lifecycle wiring, not browser rendering or platform passkeys.
function page() {
  let click!: () => Promise<void>;
  const listeners = new Map<string, (event?: { persisted?: boolean }) => void>();
  const button = {
    disabled: false,
    addEventListener(_name: string, callback: () => Promise<void>) {
      click = callback;
    },
  };
  const status = { textContent: "" };
  const credential = { value: "" };
  const form = { elements: { csrf: { value: "A".repeat(43) } }, submit: vi.fn() };
  const elements: Record<string, unknown> = {
    login: button,
    status,
    credential,
    "login-form": form,
  };
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ options: { challenge: "AQID", rpId: "id.example.test" } }),
  }));
  const get = vi.fn(async (_options: unknown): Promise<unknown> => ({
    id: "-_8",
    rawId: new Uint8Array([251, 255]).buffer,
    type: "public-key",
    getClientExtensionResults: () => ({}),
    response: {
      authenticatorData: new Uint8Array([1]).buffer,
      clientDataJSON: new Uint8Array([2]).buffer,
      signature: new Uint8Array([3]).buffer,
      userHandle: new Uint8Array([4]).buffer,
    },
  }));
  const reload = vi.fn();
  const html = nativePasskeyPage("A".repeat(43), "B".repeat(22));
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
  runInNewContext(script, {
    document: { getElementById: (id: string) => elements[id] },
    window: {
      PublicKeyCredential: class {},
      addEventListener: (name: string, fn: (event?: { persisted?: boolean }) => void) =>
        listeners.set(name, fn),
    },
    navigator: { credentials: { get } },
    location: { reload },
    fetch,
    atob,
    btoa,
    Uint8Array,
    AbortController,
  });
  return { click, listeners, button, status, credential, form, fetch, get, reload, html };
}

describe("native passkey page explicit action and interrupted flow", () => {
  it("does no credential/network work until the user clicks", () => {
    const ui = page();
    expect(ui.fetch).not.toHaveBeenCalled();
    expect(ui.get).not.toHaveBeenCalled();
    expect(ui.html).toContain('role="status" aria-live="polite"');
    expect(ui.html).toContain('type="button"');
    expect(ui.html).not.toContain('src="https://');
  });
  it("requests required UV, sends only the serialized proof, and performs a top-level form POST", async () => {
    const ui = page();
    await ui.click();
    expect(ui.fetch).toHaveBeenCalledOnce();
    expect(ui.get).toHaveBeenCalledOnce();
    expect(ui.get.mock.calls[0][0]).toMatchObject({
      publicKey: { rpId: "id.example.test", userVerification: "required" },
    });
    expect(JSON.parse(ui.credential.value)).toMatchObject({
      id: "-_8",
      rawId: "-_8",
      response: { signature: "Aw", userHandle: "BA" },
    });
    expect(ui.form.submit).toHaveBeenCalledOnce();
    expect(ui.button.disabled).toBe(true);
  });
  it("allows retry after a cancelled credential prompt", async () => {
    const ui = page();
    ui.get.mockRejectedValueOnce(
      Object.assign(new Error("cancelled"), { name: "NotAllowedError" }),
    );
    await ui.click();
    expect(ui.status.textContent).toContain("キャンセル");
    expect(ui.button.disabled).toBe(false);
    expect(ui.form.submit).not.toHaveBeenCalled();
    await ui.click();
    expect(ui.form.submit).toHaveBeenCalledOnce();
  });
  it("does not get stuck if a browser returns no credential", async () => {
    const ui = page();
    ui.get.mockResolvedValueOnce(null);
    await ui.click();
    expect(ui.button.disabled).toBe(false);
    expect(ui.form.submit).not.toHaveBeenCalled();
  });
  it("suppresses double clicks and stale completion after navigating away", async () => {
    const ui = page();
    let resolve!: (key: unknown) => void;
    ui.get.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = ui.click();
    await vi.waitFor(() => expect(ui.get).toHaveBeenCalledOnce());
    await ui.click();
    expect(ui.fetch).toHaveBeenCalledOnce();
    ui.listeners.get("pagehide")!();
    resolve({});
    await first;
    expect(ui.form.submit).not.toHaveBeenCalled();
  });
  it("reloads restored back/forward pages rather than replaying consumed context", () => {
    const ui = page();
    ui.listeners.get("pageshow")!({ persisted: true });
    expect(ui.reload).toHaveBeenCalledOnce();
  });
});
