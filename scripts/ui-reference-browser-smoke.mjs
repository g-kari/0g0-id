/* global document, window, getComputedStyle */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.UI_REFERENCE_PLAYWRIGHT_MODULE || "@playwright/test");
let staticRoot = path.resolve("workers/admin/dist/client");
const reportDir = path.resolve(process.env.UI_REFERENCE_REPORT_DIR || "ui-reference-report");
const metrics = {
  total_users: 1284,
  active_sessions: 267,
  total_services: 18,
  admin_users: 6,
  banned_users: 12,
  recent_logins_24h: 438,
  recent_logins_7d: 2916,
  login_provider_stats_7d: [{ provider: "google", count: 2916 }],
  login_country_stats_7d: [{ country: "JP", count: 2916 }],
};
const report = {
  status: "running",
  scope:
    "Built admin and account UI; synthetic read-only API fixtures; all non-loopback requests and writes blocked; no production API or writable server",
  cases: [],
  bfcacheRestorations: [],
  limitations: [],
};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (req.method !== "GET" || pathname.startsWith("/api/")) {
    res.writeHead(405).end();
    return;
  }
  const relative = path.extname(pathname) ? pathname : `${pathname.replace(/\/$/, "")}/index.html`;
  const filename = path.resolve(staticRoot, `.${decodeURIComponent(relative)}`);
  if (!filename.startsWith(`${staticRoot}${path.sep}`)) {
    res.writeHead(400).end();
    return;
  }
  try {
    const bytes = await readFile(filename);
    const contentType = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
    }[path.extname(filename)];
    res
      .writeHead(200, {
        "Content-Type": contentType || "application/octet-stream",
        "Cache-Control": "no-cache",
      })
      .end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
try {
  await mkdir(reportDir, { recursive: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
    ...(process.env.UI_REFERENCE_CHROMIUM_PATH
      ? { executablePath: process.env.UI_REFERENCE_CHROMIUM_PATH }
      : {}),
  });
  report.browser = browser.version();
  const fixtureNow = Date.now();
  const createdAt = new Date(fixtureNow - 3_600_000).toISOString();
  const expiresAt = new Date(fixtureNow + 86_400_000).toISOString();
  const adminFixtures = {
    "/api/users": [
      {
        id: "synthetic-user",
        name: "Synthetic profile",
        email: "synthetic@example.invalid",
        picture: null,
        role: "user",
        banned_at: null,
        created_at: createdAt,
      },
    ],
    "/api/services": [
      {
        id: "synthetic-service",
        name: "Synthetic service",
        client_id: "synthetic-client",
        allowed_scopes: "openid profile",
        owner_user_id: "synthetic-user",
        created_at: createdAt,
      },
    ],
    "/api/metrics/dbsc-bindings": {
      total: 12,
      device_bound: 8,
      unbound: 4,
      by_bff_origin: [{ bff_origin: origin, total: 12, device_bound: 8, unbound: 4 }],
    },
    "/api/metrics/login-trends": Array.from({ length: 7 }, (_, index) => ({
      date: new Date(fixtureNow - (6 - index) * 86_400_000).toISOString().slice(0, 10),
      count: 8 + index * 3,
    })),
    "/api/metrics/suspicious-logins": [
      { user_id: "synthetic-user", country_count: 2, countries: "JP, US" },
    ],
    "/api/security-trends/ip-stats": [{ ip_address: "192.0.2.1", count: 12, last_seen: createdAt }],
    "/api/security-trends/user-agent-stats": [{ user_agent: "Synthetic browser", count: 12 }],
  };
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
    { width: 390, height: 320 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__uiReferencePageShown = false;
      window.addEventListener("pagehide", () => {
        window.__uiReferencePageShown = false;
      });
      window.addEventListener("pageshow", (event) => {
        window.__uiReferencePersisted = event.persisted;
        window.__uiReferencePageShown = true;
      });
    });
    const errors = [],
      blockedOrigins = [],
      unexpectedWrites = [],
      unexpectedReads = [];
    let metricsCalls = 0,
      metricMode = "success",
      holdMetrics;
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) {
        blockedOrigins.push(url.origin);
        await route.abort();
        return;
      }
      if (request.method() !== "GET") {
        unexpectedWrites.push(url.pathname);
        await route.abort();
        return;
      }
      if (url.pathname === "/api/metrics") {
        metricsCalls++;
        if (metricMode === "hold")
          await new Promise((resolve) => {
            holdMetrics = resolve;
          });
        if (metricMode === "error") {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "SYNTHETIC_UNAVAILABLE", message: "synthetic_unavailable" },
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: metrics }),
        });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (!Object.hasOwn(adminFixtures, url.pathname)) {
          unexpectedReads.push(url.pathname);
          return route.abort();
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: adminFixtures[url.pathname] }),
        });
        return;
      }
      await route.continue();
    });
    await page.goto(`${origin}/?error=not_admin`);
    await page.getByRole("heading", { name: "管理者ログイン", exact: true }).waitFor();
    await page.locator("#error-message").waitFor({ state: "visible" });
    assert.equal(await page.locator("#error-message").textContent(), "管理者権限がありません");
    assert.equal(
      await page.getByRole("link", { name: "Google でログイン" }).getAttribute("href"),
      "/auth/login",
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
    );
    await page.screenshot({
      path: path.join(reportDir, `admin-login-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
    });
    report.cases.push(
      `admin login layout, error and unchanged sign-in destination at ${viewport.width}x${viewport.height}px`,
    );
    await page.goto(`${origin}/dashboard`);
    await page.locator("#total-users").waitFor({ state: "visible" });
    assert.equal(await page.locator("#total-users").textContent(), "1,284");
    assert.equal(await page.locator("#active-sessions").textContent(), "267");
    assert.equal(await page.locator("#recent-logins-7d").textContent(), "2,916");
    assert.equal(
      await page
        .locator('.sidebar-link[aria-current="page"]')
        .textContent()
        .then((t) => t.trim()),
      "ダッシュボード",
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
    );
    await page.screenshot({
      path: path.join(reportDir, `dashboard-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
    });
    report.cases.push(`dashboard metrics and layout at ${viewport.width}x${viewport.height}px`);

    metricMode = "hold";
    await page.locator("#refresh-metrics").click();
    await page.waitForFunction(() => document.querySelector("#refresh-metrics").disabled);
    await page.locator("#refresh-metrics").evaluate((button) => {
      button.click();
      button.click();
    });
    while (!holdMetrics) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(metricsCalls, 2, "Repeated refresh must not issue duplicate reads while pending");
    metricMode = "success";
    holdMetrics();
    await page.waitForFunction(() => !document.querySelector("#refresh-metrics").disabled);
    metricMode = "error";
    await page.locator("#refresh-metrics").click();
    await page.locator("#error").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#total-users").textContent(),
      "1,284",
      "Refresh errors preserve the previous data",
    );
    metricMode = "success";
    await page.locator("#refresh-metrics").click();
    await page.locator("#error").waitFor({ state: "hidden" });
    await page.waitForFunction(() => !document.querySelector("#refresh-metrics").disabled);
    report.cases.push(
      `refresh pending, repeated clicks, failure and retry at ${viewport.width}x${viewport.height}px`,
    );

    if (viewport.width < 768) {
      await page.locator("#hamburger").click();
      assert.equal(
        await page.locator("#sidebar-close").evaluate((el) => el === document.activeElement),
        true,
      );
      assert.equal(await page.locator("#admin-workspace").evaluate((el) => el.inert), true);
      assert.equal(await page.locator("#hamburger").getAttribute("aria-expanded"), "true");
      if (viewport.height < 400) {
        assert.equal(
          await page.locator("#sidebar").evaluate((el) => getComputedStyle(el).overflowY),
          "auto",
        );
        await page.locator(".sidebar-logout").scrollIntoViewIfNeeded();
        const footer = await page.locator(".sidebar-logout").boundingBox();
        assert.ok(footer && footer.y >= 0 && footer.y + footer.height <= viewport.height);
        report.cases.push("short viewport sidebar scroll keeps logout reachable");
      }
      await page.keyboard.press("Escape");
      assert.equal(
        await page.locator("#hamburger").evaluate((el) => el === document.activeElement),
        true,
      );
      assert.equal(await page.locator("#admin-workspace").evaluate((el) => el.inert), false);
      await page.locator("#hamburger").click();
      await page.locator("#sidebar .sidebar-logo").focus();
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await page.locator(".sidebar-logout").evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await page
          .locator("#sidebar .sidebar-logo")
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.locator("#sidebar-close").click();
      await page.locator("#hamburger").click();
      await page
        .locator("#sidebar-overlay")
        .click({ position: { x: viewport.width - 10, y: 200 } });
      assert.equal(await page.locator("#hamburger").getAttribute("aria-expanded"), "false");
      await page.locator("#hamburger").click();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForFunction(
        () =>
          !window.matchMedia("(max-width: 767px)").matches &&
          !document.querySelector("#admin-workspace").inert &&
          !document.querySelector("#sidebar").inert &&
          document.querySelector("#hamburger").getAttribute("aria-expanded") === "false" &&
          !document.body.classList.contains("menu-open"),
        null,
        { timeout: 5000 },
      );
      assert.equal(await page.locator("#admin-workspace").evaluate((el) => el.inert), false);
      assert.equal(await page.locator("#sidebar").evaluate((el) => el.inert), false);
      await page.setViewportSize(viewport);
      await page.waitForFunction(
        () =>
          window.matchMedia("(max-width: 767px)").matches &&
          !document.querySelector("#admin-workspace").inert &&
          document.querySelector("#sidebar").inert &&
          document.querySelector("#hamburger").getAttribute("aria-expanded") === "false" &&
          !document.body.classList.contains("menu-open"),
        null,
        { timeout: 5000 },
      );
      assert.equal(await page.locator("#sidebar").evaluate((el) => el.inert), true);
      await page.locator("#hamburger").click();
      await page.locator('#sidebar a[href="/services"]').click();
      await page.waitForURL("**/services");
      await page.goBack();
      await page.waitForURL("**/dashboard");
      await page.waitForFunction(() => window.__uiReferencePageShown === true);
      assert.equal(await page.locator("#hamburger").getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator("#admin-workspace").evaluate((el) => el.inert), false);
      await page.goForward();
      await page.waitForURL("**/services");
      await page.waitForFunction(() => window.__uiReferencePageShown === true);
      assert.equal(await page.locator("#hamburger").getAttribute("aria-expanded"), "false");
      report.cases.push(
        "mobile menu focus loop, Escape, close, overlay, repeat open, breakpoint and history navigation",
      );
      await page.goto(`${origin}/dashboard`);
      await page.locator("#total-users").waitFor({ state: "visible" });
      await page.locator("#hamburger").click();
      // Leave the old document with the menu open, so restoration must reset it.
      await page.goto(`${origin}/services`);
      await page.goBack();
      await page.waitForURL("**/dashboard");
      await page.waitForFunction(() => window.__uiReferencePageShown === true);
      const persisted = await page.evaluate(() => window.__uiReferencePersisted === true);
      report.bfcacheRestorations.push({ viewport, persisted });
      assert.equal(await page.locator("#hamburger").getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator("#admin-workspace").evaluate((el) => el.inert), false);
      if (persisted) {
        assert.equal(
          await page.locator("#hamburger").evaluate((el) => el === document.activeElement),
          true,
        );
        report.cases.push("persisted BFCache restore closes the old open menu and returns focus");
      } else {
        report.limitations.push(
          `No persisted BFCache restoration observed at ${viewport.width}x${viewport.height}; pageshow logic is covered separately by DOM tests.`,
        );
      }
    }
    for (const route of [
      { path: "/users", ready: ["#user-tbody tr", "#dbsc-summary"], label: "ユーザー管理" },
      { path: "/services", ready: ["#service-tbody tr"], label: "サービス管理" },
      {
        path: "/security/dashboard",
        ready: ["#trends-chart svg", "#suspicious-tbody tr", "#ip-tbody tr", "#ua-tbody tr"],
        label: "セキュリティ",
      },
    ]) {
      await page.goto(`${origin}${route.path}`);
      for (const ready of route.ready) await page.locator(ready).waitFor({ state: "visible" });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false,
        `${route.path} must not overflow the viewport`,
      );
      assert.equal(await page.locator('.sidebar-link[aria-current="page"]').count(), 1);
      assert.equal(
        (await page.locator('.sidebar-link[aria-current="page"]').textContent()).trim(),
        route.label,
      );
      for (const scrollRegion of await page.locator(".table-wrap").all()) {
        await scrollRegion.focus();
        assert.equal(await scrollRegion.evaluate((el) => el === document.activeElement), true);
      }
      await page.locator(".page-title").click();
      await page.screenshot({
        path: path.join(
          reportDir,
          `admin${route.path.replaceAll("/", "-")}-${viewport.width}x${viewport.height}.png`,
        ),
        fullPage: true,
      });
      report.cases.push(
        `admin ${route.path} populated layout at ${viewport.width}x${viewport.height}px`,
      );
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedWrites, []);
    assert.deepEqual(unexpectedReads, []);
    assert.deepEqual(blockedOrigins, []);
    await context.close();
  }
  staticRoot = path.resolve("workers/user/dist/client");
  const userFixtures = {
    "/api/me": {
      id: "synthetic-user",
      email: "synthetic@example.invalid",
      name: "Synthetic profile",
      picture: null,
      phone: null,
      address: null,
      role: "user",
    },
    "/api/me/bff-sessions": [
      {
        id: "synthetic-browser-session",
        user_id: "synthetic-user",
        bff_origin: origin,
        user_agent: "Synthetic desktop browser",
        ip: "192.0.2.1",
        has_device_key: false,
        device_bound_at: null,
        created_at: Math.floor((fixtureNow - 3_600_000) / 1000),
        expires_at: Math.floor((fixtureNow + 86_400_000) / 1000),
      },
    ],
    "/api/me/sessions": [
      {
        id: "synthetic-app-session",
        service_id: "synthetic-service",
        service_name: "Synthetic service",
        created_at: createdAt,
        expires_at: expiresAt,
      },
    ],
    "/api/providers": ["google", "line", "twitch", "github", "x"].map((provider) => ({
      provider,
      connected: provider === "google",
    })),
    "/api/connections": [
      {
        service_id: "synthetic-service",
        service_name: "Synthetic service",
        client_id: "synthetic-client",
        first_authorized_at: "2026-10-01T00:00:00Z",
        last_authorized_at: createdAt,
        pairwise_sub: `synthetic-sub-${"a".repeat(64)}`,
      },
    ],
    "/api/me/login-history": [
      {
        id: "synthetic-login",
        user_id: "synthetic-user",
        provider: "google",
        success: 1,
        ip_address: "192.0.2.1",
        country: "JP",
        user_agent: "Synthetic browser",
        created_at: createdAt,
      },
    ],
    "/api/me/login-stats": [{ provider: "google", count: 12 }],
    "/api/me/security/login-trends": [{ date: createdAt.slice(0, 10), count: 12 }],
  };
  const userRoutes = [
    { path: "/profile", ready: ["#content"] },
    { path: "/sessions", ready: ["#bff-list", "#list"] },
    { path: "/providers", ready: ["#provider-content"] },
    { path: "/connections", ready: ["#list"] },
    { path: "/login-history", ready: ["#list"] },
    { path: "/login-stats", ready: ["#providers-card", "#trends-card"] },
    { path: "/device", ready: ["#step-code"] },
  ];
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 740 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [],
      blockedOrigins = [],
      unexpectedWrites = [],
      unexpectedReads = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) {
        blockedOrigins.push(url.origin);
        return route.abort();
      }
      if (request.method() !== "GET") {
        unexpectedWrites.push(url.pathname);
        return route.abort();
      }
      if (url.pathname.startsWith("/api/")) {
        if (!Object.hasOwn(userFixtures, url.pathname)) {
          unexpectedReads.push(url.pathname);
          return route.abort();
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: userFixtures[url.pathname] }),
        });
      }
      await route.continue();
    });
    for (const route of userRoutes) {
      const waitForCurrentTab = () =>
        page.waitForFunction(
          () => {
            const nav = document.querySelector(".account-nav");
            const current = nav?.querySelector('[aria-current="page"]');
            if (!nav?.clientWidth || !current) return false;
            const bounds = nav.getBoundingClientRect();
            const item = current.getBoundingClientRect();
            const left = bounds.left + nav.clientLeft;
            return item.left >= left - 1 && item.right <= left + nav.clientWidth + 1;
          },
          null,
          { timeout: 3000 },
        );
      await page.goto(`${origin}${route.path}`);
      for (const ready of route.ready) await page.locator(ready).waitFor({ state: "visible" });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false,
        `${route.path} must not overflow the viewport`,
      );
      if (route.path !== "/device") {
        await waitForCurrentTab();
        assert.equal(await page.locator('.account-nav [aria-current="page"]').count(), 1);
        assert.equal(await page.locator(".user-intro h1").textContent(), "アカウント設定");
        assert.deepEqual(
          await page
            .locator(".account-nav .account-nav-item")
            .evaluateAll(
              (items, currentPath) =>
                items
                  .filter(
                    (item) =>
                      item.hasAttribute("href") || item.getAttribute("aria-current") === "page",
                  )
                  .map((item) => item.getAttribute("href") || currentPath),
              route.path,
            ),
          ["/profile", "/sessions", "/connections", "/providers", "/login-history", "/login-stats"],
        );
      }
      await page.screenshot({
        path: path.join(
          reportDir,
          `user${route.path.replaceAll("/", "-")}-${viewport.width}x${viewport.height}.png`,
        ),
        fullPage: true,
      });
      if (route.path !== "/device") {
        await page.locator(".skip-link").focus();
        await page.keyboard.press("Enter");
        assert.equal(
          await page.locator("#main-content").evaluate((el) => el === document.activeElement),
          true,
        );
        if (viewport.width <= 720) {
          const beforeRestore = await page.evaluate(() => {
            document.querySelector(".account-nav").scrollLeft = 0;
            const before = {
              x: window.scrollX,
              y: window.scrollY,
              focus: document.activeElement.id,
            };
            // Synthetic handler check, not an observed BFCache restoration.
            window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
            return before;
          });
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
              ),
          );
          await waitForCurrentTab();
          assert.deepEqual(
            await page.evaluate(() => ({
              x: window.scrollX,
              y: window.scrollY,
              focus: document.activeElement.id,
            })),
            beforeRestore,
            "Revealing the current tab on pageshow must preserve focus and page scroll",
          );
          if (route.path === "/providers" && viewport.width === 390) {
            await page.setViewportSize({ width: 1280, height: 900 });
            await page.waitForFunction(() => !window.matchMedia("(max-width: 720px)").matches);
            await page.setViewportSize(viewport);
            await page.waitForFunction(
              () => window.matchMedia("(max-width: 720px)").matches,
              null,
              { timeout: 3000 },
            );
            await waitForCurrentTab();
            report.cases.push(
              "user /providers current tab revealed after desktop-to-mobile resize",
            );
          }
        }
      }
      report.cases.push(
        `user ${route.path} populated layout at ${viewport.width}x${viewport.height}px`,
      );
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedWrites, []);
    assert.deepEqual(unexpectedReads, []);
    assert.deepEqual(blockedOrigins, []);
    await context.close();
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
