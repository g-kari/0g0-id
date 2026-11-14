// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  renderDeviceScopeBadges,
  renderLinkedSessionRows,
  renderProfileAvatarHtml,
  renderProviderListHtml,
} from "../safe-markup";

const MARKUP = "<img src=x onerror=alert(1)>";
const BREAKOUT = `"><img src=x onerror=alert(1)>`;

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function mount(html: string): HTMLElement {
  document.body.innerHTML = `<div id="root">${html}</div>`;
  return document.getElementById("root")!;
}

describe("renderProfileAvatarHtml", () => {
  it("shows initials for a normal profile without a picture", () => {
    const root = mount(
      renderProfileAvatarHtml({ name: "Ada Lovelace", email: "ada@example.com", picture: null }),
    );
    expect(root.textContent).toBe("AL");
    expect(root.querySelector("img")).toBeNull();
  });

  it("does not interpret a stored name as HTML when building initials", () => {
    const html = renderProfileAvatarHtml({ name: MARKUP, email: "ada@example.com", picture: null });
    const root = mount(html);
    expect(html).toContain("&lt;");
    expect(html).not.toContain("<img");
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[onerror]")).toBeNull();
    expect(root.textContent).toBe("<S");
  });

  it("does not let a stored picture URL break out of the src attribute", () => {
    const root = mount(
      renderProfileAvatarHtml({ name: "Ada", email: "ada@example.com", picture: BREAKOUT }),
    );
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.querySelector("[onerror]")).toBeNull();
    expect(root.querySelector("img")?.getAttribute("src")).toBe(BREAKOUT);
  });
});

describe("renderDeviceScopeBadges", () => {
  it("does not interpret a client-supplied scope as HTML", () => {
    const root = mount(renderDeviceScopeBadges([MARKUP, "profile"]));
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[onerror]")).toBeNull();
    expect(root.textContent).toContain(MARKUP);
    expect(root.textContent).toContain("profile");
  });
});

describe("renderLinkedSessionRows", () => {
  it("does not interpret a stored service name or session id as HTML", () => {
    const root = mount(
      renderLinkedSessionRows([
        {
          id: BREAKOUT,
          service_name: MARKUP,
          created_at: "2026-01-02T00:00:00.000Z",
          expires_at: "2026-02-02T00:00:00.000Z",
        },
      ]),
    );
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[onerror]")).toBeNull();
    expect(root.textContent).toContain(MARKUP);
    expect(root.querySelector("button")?.dataset.revoke).toBe(BREAKOUT);
  });
});

describe("renderProviderListHtml", () => {
  it("keeps a known provider icon and does not interpret an unknown provider as HTML", () => {
    const root = mount(
      renderProviderListHtml(
        [
          { provider: "google", connected: false },
          { provider: MARKUP, connected: false },
        ],
        {
          labels: { google: "Google" },
          icons: { google: '<svg id="google-icon"></svg>' },
          isConfigured: () => true,
          linkedCount: 2,
        },
      ),
    );

    expect(root.querySelector("#google-icon")).not.toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[onerror]")).toBeNull();
    expect(root.textContent).toContain("Google");
    expect(root.textContent).toContain(MARKUP);
    expect(root.querySelector("form input")?.getAttribute("value")).toBe("google");
  });

  it("keeps a connected provider visible and hides a link action that is not configured", () => {
    const disconnected = mount(
      renderProviderListHtml([{ provider: "discord", connected: false }], {
        labels: { discord: "Discord" },
        icons: {},
        isConfigured: () => false,
        linkedCount: 1,
      }),
    );
    expect(disconnected.querySelector("form, button")).toBeNull();
    expect(disconnected.textContent).toContain("Discord");
    expect(disconnected.textContent).toContain("現在利用できません");

    const connected = mount(
      renderProviderListHtml([{ provider: "discord", connected: true }], {
        labels: { discord: "Discord" },
        icons: {},
        isConfigured: () => false,
        linkedCount: 2,
      }),
    );
    expect(connected.querySelector("button")?.textContent).toContain("連携解除");
    expect(connected.textContent).toContain("Discord");
  });

  it("does not let a provider value break out of an attribute", () => {
    const root = mount(
      renderProviderListHtml([{ provider: BREAKOUT, connected: true }], {
        labels: {},
        icons: {},
        isConfigured: () => true,
        linkedCount: 2,
      }),
    );
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[onerror]")).toBeNull();
    expect(root.querySelector("button")?.dataset.unlink).toBe(BREAKOUT);
  });
});

describe("user pages", () => {
  it("renders untrusted fields through the escaping helpers", () => {
    const profile = source("../../pages/profile.astro");
    expect(profile).toContain("renderProfileAvatarHtml");
    expect(profile).not.toContain("${getInitials");
    expect(profile).not.toContain("${escapeHtml(user.picture)}");

    const device = source("../../pages/device.astro");
    expect(device).toContain("renderDeviceScopeBadges");
    expect(device).not.toContain("${s}</span>");

    const sessions = source("../../pages/sessions.astro");
    expect(sessions).toContain("renderLinkedSessionRows");
    expect(sessions).not.toContain('data-revoke="${s.id}"');

    const providers = source("../../pages/providers.astro");
    expect(providers).toContain("renderProviderListHtml");
    expect(providers).not.toContain("${status.provider}");
  });
});
