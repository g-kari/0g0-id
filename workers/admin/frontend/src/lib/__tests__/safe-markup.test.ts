// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  renderAdminServiceRows,
  renderAdminUserRows,
  renderAdminUserSessions,
  renderAuthorizedUsers,
  renderDefinitionRows,
  renderRedirectUriItems,
  renderTrendPointText,
  renderUserBadges,
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

function mountRows(html: string): HTMLElement {
  document.body.innerHTML = `<table><tbody id="root">${html}</tbody></table>`;
  return document.getElementById("root")!;
}

function expectStoredText(root: ParentNode, payload: string): void {
  expect(root.querySelector("img")).toBeNull();
  expect(root.querySelector("[onerror]")).toBeNull();
  expect(root.textContent).toContain(payload);
}

describe("renderAdminUserRows", () => {
  it("renders a normal user as text and a safe detail link", () => {
    const root = mountRows(
      renderAdminUserRows([
        {
          id: "0123456789abcdef",
          email: "ada@example.com",
          name: "Ada Lovelace",
          role: "admin",
          status: "active",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ]),
    );

    expect(root.textContent).toContain("Ada Lovelace");
    expect(root.textContent).toContain("ada@example.com");
    expect(root.textContent).toContain("管理者");
    expect(root.textContent).toContain("アクティブ");
    expect(root.querySelector("a")?.getAttribute("href")).toBe("/users/0123456789abcdef");
    expect(root.querySelector("img")).toBeNull();
  });

  it("does not interpret a stored name or email as HTML", () => {
    const root = mountRows(
      renderAdminUserRows([
        {
          id: "user-1",
          email: MARKUP,
          name: MARKUP,
          role: "user",
          status: "banned",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ]),
    );

    expectStoredText(root, MARKUP);
    expect(root.textContent).toContain("BAN");
  });

  it("does not let a stored id or role break out of an attribute", () => {
    const root = mountRows(
      renderAdminUserRows([
        {
          id: BREAKOUT,
          email: "ada@example.com",
          name: "Ada",
          role: BREAKOUT,
          status: "active",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ]),
    );

    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[onerror]")).toBeNull();
    expect(root.querySelector("a")?.getAttribute("href")).toBe(
      `/users/${encodeURIComponent(BREAKOUT)}`,
    );
    expect(root.querySelector("td[title]")?.getAttribute("title")).toBe(BREAKOUT);
  });
});

describe("renderAdminServiceRows", () => {
  it("does not interpret a stored service name or client id as HTML", () => {
    const root = mountRows(
      renderAdminServiceRows([
        {
          id: BREAKOUT,
          name: MARKUP,
          client_id: MARKUP,
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ]),
    );

    expectStoredText(root, MARKUP);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("a")?.getAttribute("href")).toBe(
      `/services/${encodeURIComponent(BREAKOUT)}`,
    );
    expect(root.querySelector("button")?.dataset.name).toBe(MARKUP);
    expect(root.querySelector("button")?.dataset.id).toBe(BREAKOUT);
  });
});

describe("renderDefinitionRows", () => {
  it("does not interpret stored field values as HTML", () => {
    const root = mountRows(renderDefinitionRows([["ID (Sub)", MARKUP]]));
    expectStoredText(root, MARKUP);
  });
});

describe("renderUserBadges", () => {
  it("does not let a stored role break out of the class attribute", () => {
    const root = mount(renderUserBadges(BREAKOUT, false));
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[onerror]")).toBeNull();
    expect(root.textContent).toContain("ユーザー");
    expect(root.textContent).toContain("アクティブ");
  });
});

describe("renderRedirectUriItems", () => {
  it("does not interpret a stored redirect URI as HTML", () => {
    const root = mount(renderRedirectUriItems([{ id: BREAKOUT, uri: MARKUP }]));
    expectStoredText(root, MARKUP);
    expect(root.querySelector("button")?.dataset.id).toBe(BREAKOUT);
  });
});

describe("renderAuthorizedUsers", () => {
  it("does not interpret a stored name, email, or picture as HTML", () => {
    const root = mount(
      renderAuthorizedUsers([
        { id: BREAKOUT, name: MARKUP, email: MARKUP, picture: BREAKOUT },
        { id: "user-2", name: MARKUP, email: "ada@example.com", picture: null },
      ]),
    );

    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.querySelector("[onerror]")).toBeNull();
    expect(root.querySelector("img")?.getAttribute("src")).toBe(BREAKOUT);
    expect(root.textContent).toContain(MARKUP);
    expect(root.querySelector("button")?.dataset.id).toBe(BREAKOUT);
  });
});

describe("renderAdminUserSessions", () => {
  it("does not interpret a stored service name or session id as HTML", () => {
    const root = mount(
      renderAdminUserSessions([
        {
          id: BREAKOUT,
          service_name: MARKUP,
          created_at: "2026-01-02T00:00:00.000Z",
          expires_at: "2026-02-02T00:00:00.000Z",
        },
      ]),
    );

    expectStoredText(root, MARKUP);
    expect(root.querySelector("button")?.dataset.id).toBe(BREAKOUT);
  });
});

describe("renderTrendPointText", () => {
  it("does not interpret a trend date as SVG or HTML", () => {
    const text = renderTrendPointText(MARKUP, 3);
    const root = mount(`<svg><title>${text.title}</title><text>${text.label}</text></svg>`);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[onerror]")).toBeNull();
    expect(root.querySelector("title")?.textContent).toContain(MARKUP);
    expect(root.querySelector("title")?.textContent).toContain("3");
  });
});

describe("admin pages", () => {
  it("renders stored user and service fields through the escaping helpers", () => {
    const users = source("../../pages/users/index.astro");
    expect(users).toContain("renderAdminUserRows");
    expect(users).not.toContain("${user.name");
    expect(users).not.toContain("${user.email");
    expect(users).not.toContain("${user.id");

    const services = source("../../pages/services/index.astro");
    expect(services).toContain("renderAdminServiceRows");
    expect(services).not.toContain("${service.name");
    expect(services).not.toContain("${service.client_id");
    expect(services).not.toContain("${service.id");

    const serviceDetail = source("../../pages/services/detail.astro");
    expect(serviceDetail).toContain("renderDefinitionRows");
    expect(serviceDetail).toContain("renderRedirectUriItems");
    expect(serviceDetail).toContain("renderAuthorizedUsers");
    expect(serviceDetail).not.toContain("${u.uri}");
    expect(serviceDetail).not.toContain("${u.name");
    expect(serviceDetail).not.toContain("${u.email");
    expect(serviceDetail).not.toContain("${u.picture");
    expect(serviceDetail).not.toContain("${value}");

    const userDetail = source("../../pages/users/detail.astro");
    expect(userDetail).toContain("renderDefinitionRows");
    expect(userDetail).toContain("renderUserBadges");
    expect(userDetail).toContain("renderAdminUserSessions");
    expect(userDetail).not.toContain("${value}");
    expect(userDetail).not.toContain('data-id="${s.id}"');
    expect(userDetail).not.toContain("${user.role}");

    const dashboard = source("../../pages/security/dashboard.astro");
    expect(dashboard).toContain("renderTrendPointText");
    expect(dashboard).not.toContain("${p.d.date");
    expect(dashboard).not.toContain("${label}");
  });
});
