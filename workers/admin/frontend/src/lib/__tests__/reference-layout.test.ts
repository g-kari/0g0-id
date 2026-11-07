// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new NodeURL(relative, import.meta.url)), "utf8");
}
function body(page: string, layout: string): string {
  return page.split(new RegExp(`<${layout}[^>]*>`))[1].split(`</${layout}>`)[0];
}
function script(page: string): string {
  return ts.transpileModule(page.split("<script>")[1].split("</script>")[0], {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("reference admin navigation DOM behavior", () => {
  function setup(matches = true) {
    const page = source("../../layouts/Admin.astro");
    document.body.innerHTML = body(page, "Base");
    const media = new EventTarget() as MediaQueryList;
    Object.defineProperty(media, "matches", { value: matches, writable: true });
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    runInNewContext(script(page), { document, window });
    const menu = document.getElementById("sidebar")!;
    const workspace = document.getElementById("admin-workspace")!;
    const trigger = document.getElementById("hamburger") as HTMLButtonElement;
    const close = document.getElementById("sidebar-close") as HTMLButtonElement;
    return { media, menu, workspace, trigger, close };
  }

  it("has named landmarks, a skip link and the original logout POST", () => {
    const { menu, trigger } = setup();
    expect(menu.getAttribute("aria-label")).toBe("管理メニュー");
    expect(trigger.getAttribute("aria-controls")).toBe("sidebar");
    expect(document.querySelector(".skip-link")?.getAttribute("href")).toBe("#main-content");
    expect(document.querySelector(".sidebar-footer form")?.getAttribute("method")).toBe("post");
    expect(document.querySelector(".sidebar-footer form")?.getAttribute("action")).toBe(
      "/auth/logout",
    );
  });

  it("starts closed, opens on request and restores focus after Escape", () => {
    const { menu, workspace, trigger, close } = setup();
    expect(menu.inert).toBe(true);
    expect(workspace.inert).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click();
    expect(menu.inert).toBe(false);
    expect(workspace.inert).toBe(true);
    expect(document.activeElement).toBe(close);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu.inert).toBe(true);
    expect(workspace.inert).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(document.body.classList.contains("menu-open")).toBe(false);
  });

  it("supports repeated open/close and backdrop dismissal", () => {
    const { menu, trigger, close } = setup();
    for (let i = 0; i < 3; i++) {
      trigger.click();
      close.click();
    }
    trigger.click();
    document.getElementById("sidebar-overlay")!.click();
    expect(menu.classList.contains("open")).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps Tab and Shift+Tab within an open mobile menu", () => {
    const { menu, trigger } = setup();
    trigger.click();
    const first = menu.querySelector<HTMLElement>("a[href]")!;
    const last = menu.querySelector<HTMLElement>(".sidebar-logout")!;
    last.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
    expect(document.activeElement).toBe(first);
    first.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(last);
  });

  it("clears mobile modality on desktop resize and history restoration", () => {
    const { media, menu, workspace, trigger } = setup();
    trigger.click();
    Object.defineProperty(media, "matches", { value: false });
    media.dispatchEvent(new Event("change"));
    expect(menu.inert).toBe(false);
    expect(workspace.inert).toBe(false);
    expect(document.activeElement).toBe(menu.querySelector("a[href]"));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    Object.defineProperty(media, "matches", { value: true });
    media.dispatchEvent(new Event("change"));
    trigger.click();
    window.dispatchEvent(new Event("pageshow"));
    expect(document.activeElement).toBe(trigger);
    expect(menu.inert).toBe(true);
    expect(workspace.inert).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves the desktop sidebar available and ignores mobile open requests", () => {
    const { menu, workspace, trigger } = setup(false);
    trigger.click();
    expect(menu.inert).toBe(false);
    expect(workspace.inert).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("reference dashboard DOM behavior", () => {
  const metrics = {
    total_users: 1284,
    active_sessions: 267,
    total_services: 18,
    admin_users: 6,
    banned_users: 12,
    recent_logins_24h: 438,
    recent_logins_7d: 2916,
  };
  async function setup(load: ReturnType<typeof vi.fn>) {
    const page = source("../../pages/dashboard/index.astro");
    document.body.innerHTML = body(page, "Admin");
    const client = script(page).replace(/^import \{ apiFetch \} from .*;$/m, "");
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const initial = new AsyncFunction("document", "apiFetch", client)(
      document,
      load,
    ) as Promise<void>;
    const button = document.getElementById("refresh-metrics") as HTMLButtonElement;
    return { initial, button };
  }

  it("renders all seven API values with grouped semantic metrics", async () => {
    const load = vi.fn().mockResolvedValue(metrics);
    const { initial } = await setup(load);
    await initial;
    expect(load).toHaveBeenCalledExactlyOnceWith("/api/metrics");
    expect(document.getElementById("total-users")!.textContent).toBe("1,284");
    expect(document.getElementById("active-sessions")!.textContent).toBe("267");
    expect(document.getElementById("recent-logins-7d")!.textContent).toBe("2,916");
    expect(document.getElementById("banned-users")!.textContent).toBe("12");
    expect(document.querySelectorAll(".dashboard-metric dt")).toHaveLength(4);
    expect(document.querySelectorAll(".dashboard-quick-links a")).toHaveLength(3);
    expect(document.getElementById("cards")!.getAttribute("aria-busy")).toBe("false");
  });

  it("suppresses duplicate reads while pending", async () => {
    let resolve!: (value: typeof metrics) => void;
    const load = vi.fn().mockImplementation(
      () =>
        new Promise((res) => {
          resolve = res;
        }),
    );
    const { initial, button } = await setup(load);
    expect(button.disabled).toBe(true);
    button.dispatchEvent(new Event("click"));
    button.dispatchEvent(new Event("click"));
    expect(load).toHaveBeenCalledOnce();
    resolve(metrics);
    await initial;
    expect(button.disabled).toBe(false);
  });

  it("exposes initial failure and recovers after a requested retry", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("synthetic_unavailable"))
      .mockResolvedValue(metrics);
    const { initial, button } = await setup(load);
    await initial;
    expect(document.getElementById("error")!.textContent).toBe("synthetic_unavailable");
    expect(document.getElementById("error")!.getAttribute("role")).toBe("alert");
    expect(document.getElementById("cards")!.style.display).toBe("none");
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(load).toHaveBeenCalledTimes(2);
    expect(document.getElementById("cards")!.style.display).toBe("");
    expect(document.getElementById("error")!.style.display).toBe("none");
  });

  it("preserves the latest successful metrics on refresh failure", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(metrics)
      .mockRejectedValue(new Error("synthetic_refresh_failure"));
    const { initial, button } = await setup(load);
    await initial;
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(document.getElementById("cards")!.style.display).toBe("");
    expect(document.getElementById("total-users")!.textContent).toBe("1,284");
    expect(document.getElementById("error")!.textContent).toBe("synthetic_refresh_failure");
  });
});
