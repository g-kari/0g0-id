/// <reference types="node" />
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import { emailPasskeyPage, type EmailPageMode } from "./email-passkey-page";

function ui(mode: EmailPageMode, hash = `#token=${"T".repeat(43)}`, csrf = "C".repeat(43)) {
  let act!: (event?: { preventDefault(): void }) => Promise<void>;
  const events: string[] = [];
  const handlers = new Map<string, (event?: { persisted?: boolean }) => void>();
  const button = {
    disabled: false,
    addEventListener(_type: string, fn: typeof act) {
      act = fn;
    },
  };
  const status = { textContent: "" };
  const credential = { value: "" };
  const form = {
    addEventListener(_type: string, fn: typeof act) {
      act = fn;
    },
    submit: vi.fn(),
  };
  const elements: Record<string, unknown> = {
    continue: button,
    status,
    credential,
    action: mode === "signup" || mode === "register" ? form : null,
    email: { value: "synthetic@example.test" },
    name: { value: "Synthetic" },
  };
  const fetch = vi.fn(async (_path: string, _request: { body: string }) => ({
    ok: true,
    json: async () => ({
      options: {
        challenge: "AQID",
        user: { id: "BA", name: "Synthetic", displayName: "Synthetic" },
        rp: { id: "id.example.test", name: "0g0-id" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      },
    }),
  }));
  async function createCredential(_options: unknown): Promise<unknown> {
    return {
      id: "-_8",
      rawId: new Uint8Array([251, 255]).buffer,
      type: "public-key",
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: new Uint8Array([1]).buffer,
        attestationObject: new Uint8Array([2]).buffer,
        getTransports: () => ["internal"],
      },
    };
  }
  const create = vi.fn(createCredential);
  const assign = vi.fn();
  const reload = vi.fn();
  const replaceState = vi.fn(() => {
    events.push("fragment-removed");
  });
  const html = emailPasskeyPage(mode, csrf, "N".repeat(22));
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
  runInNewContext(script, {
    document: {
      getElementById: (id: string) => {
        events.push("dom-read");
        return elements[id];
      },
    },
    location: { hash, assign, reload },
    history: { replaceState },
    window: {
      PublicKeyCredential: class {},
      addEventListener: (name: string, fn: (event?: { persisted?: boolean }) => void) =>
        handlers.set(name, fn),
    },
    navigator: { credentials: { create } },
    fetch,
    URLSearchParams,
    AbortController,
    Uint8Array,
    atob,
    btoa,
  });
  return {
    act,
    events,
    handlers,
    button,
    status,
    form,
    credential,
    fetch,
    create,
    assign,
    reload,
    replaceState,
    html,
  };
}

describe("email/passkey page explicit action and transport interruption", () => {
  it("removes the fragment before DOM/network work and does not auto-confirm", () => {
    const page = ui("verify");
    expect(page.events[0]).toBe("fragment-removed");
    expect(page.replaceState).toHaveBeenCalledWith(null, "", "/auth/email/verify");
    expect(page.fetch).not.toHaveBeenCalled();
    expect(page.create).not.toHaveBeenCalled();
    expect(page.html).not.toContain("T".repeat(43));
    expect(page.html).not.toMatch(/localStorage|sessionStorage|src="https:/);
  });
  it("clears even malformed or missing-browser fragments without accepting them", () => {
    for (const [hash, csrf] of [
      ["#token=wrong", "C".repeat(43)],
      [`#token=${"T".repeat(43)}`, ""],
      [`#token=${"T".repeat(43)}&x=1`, "C".repeat(43)],
    ]) {
      const page = ui("verify", hash, csrf);
      expect(page.replaceState).toHaveBeenCalledOnce();
      expect(page.button.disabled).toBe(true);
      expect(page.fetch).not.toHaveBeenCalled();
    }
  });
  it("sends the in-memory token only after explicit confirmation", async () => {
    const page = ui("verify");
    await page.act();
    expect(page.fetch).toHaveBeenCalledOnce();
    expect(page.fetch.mock.calls[0][0]).toBe("/auth/email/verify");
    expect(JSON.parse(page.fetch.mock.calls[0][1].body)).toEqual({
      csrf: "C".repeat(43),
      confirm: true,
      token: "T".repeat(43),
    });
    expect(page.assign).toHaveBeenCalledWith("/auth/email/register");
  });
  it("does not resend automatically after a lost email POST response", async () => {
    const page = ui("signup");
    page.fetch.mockRejectedValueOnce(new Error("lost response"));
    await page.act({ preventDefault() {} });
    expect(page.fetch).toHaveBeenCalledOnce();
    expect(page.button.disabled).toBe(false);
    await page.act({ preventDefault() {} });
    expect(page.fetch).toHaveBeenCalledTimes(2);
    expect(page.fetch.mock.calls[0][1].body).toBe(page.fetch.mock.calls[1][1].body);
    expect(page.button.disabled).toBe(true); // Same server reservation, no automatic restart.
  });
  it("requests explicit resident-key registration then submits only the proof", async () => {
    const page = ui("register");
    expect(page.create).not.toHaveBeenCalled();
    await page.act({ preventDefault() {} });
    expect(page.create).toHaveBeenCalledOnce();
    expect(page.create.mock.calls[0][0]).toMatchObject({
      publicKey: {
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      },
    });
    expect(JSON.parse(page.credential.value)).toMatchObject({
      id: "-_8",
      rawId: "-_8",
      response: { attestationObject: "Ag", transports: ["internal"] },
    });
    expect(page.form.submit).toHaveBeenCalledOnce();
  });
  it("supports retry after authenticator cancellation without automatically sending mail", async () => {
    const page = ui("register");
    page.create.mockRejectedValueOnce(
      Object.assign(new Error("cancelled"), { name: "NotAllowedError" }),
    );
    await page.act({ preventDefault() {} });
    expect(page.button.disabled).toBe(false);
    expect(page.form.submit).not.toHaveBeenCalled();
    await page.act({ preventDefault() {} });
    expect(page.form.submit).toHaveBeenCalledOnce();
    expect(
      page.fetch.mock.calls.every(([path]) => path === "/auth/email/registration/options"),
    ).toBe(true);
  });
  it("suppresses double clicks and stale options after leaving the page", async () => {
    const page = ui("register");
    let resolve!: (value: Awaited<ReturnType<typeof page.fetch>>) => void;
    page.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = page.act({ preventDefault() {} });
    await page.act({ preventDefault() {} });
    expect(page.fetch).toHaveBeenCalledOnce();
    page.handlers.get("pagehide")!();
    resolve({ ok: true, json: async () => ({ options: {} }) } as Awaited<
      ReturnType<typeof page.fetch>
    >);
    await first;
    expect(page.create).not.toHaveBeenCalled();
    expect(page.form.submit).not.toHaveBeenCalled();
  });
  it("refresh/back restoration cannot auto-repeat proof or registration", () => {
    const page = ui("verify", "");
    expect(page.button.disabled).toBe(true);
    page.handlers.get("pageshow")!({ persisted: true });
    expect(page.reload).toHaveBeenCalledOnce();
    expect(page.fetch).not.toHaveBeenCalled();
  });
});
