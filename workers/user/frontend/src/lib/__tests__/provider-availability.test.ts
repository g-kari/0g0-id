// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { applyProviderAvailability, isProviderAvailable } from "../provider-availability";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("new provider discovery", () => {
  it.each([
    undefined,
    null,
    {},
    [],
    { discord: false, steam: false },
    { discord: "true", steam: 1 },
  ])("fails closed for incomplete or invalid settings: %j", (configured) => {
    for (const provider of ["discord", "steam"]) {
      expect(isProviderAvailable(provider, configured)).toBe(false);
    }
  });
  it("only reveals explicit true and hides previously enabled options again", () => {
    document.body.innerHTML =
      '<a data-provider="discord" hidden style="display:none">Discord</a><a data-provider="steam" hidden style="display:none">Steam</a>';
    applyProviderAvailability({ discord: true, steam: false });
    const links = document.querySelectorAll<HTMLElement>("a");
    expect(links[0].hidden).toBe(false);
    expect(links[0].style.display).toBe("");
    expect(links[1].hidden).toBe(true);
    applyProviderAvailability(null);
    expect(links[0].hidden).toBe(true);
  });
  it.each(["index", "device"])("%s starts with new options hidden before discovery", (page) => {
    const source = readFileSync(new NodeURL(`../../pages/${page}.astro`, import.meta.url), "utf8");
    for (const provider of ["discord", "steam"]) {
      expect(source).toMatch(new RegExp(`data-provider="${provider}" hidden style="display:none"`));
    }
    expect(source).toContain("applyProviderAvailability(configured)");
  });
  it("keeps connected providers visible while gating new link actions", () => {
    const source = readFileSync(
      new NodeURL("../../pages/providers.astro", import.meta.url),
      "utf8",
    );
    expect(source).toContain("isProviderAvailable(status.provider, configured)");
    expect(source).toContain("const actionHtml = status.connected");
    expect(source).toContain("configured = {};\n      try");
  });
});
