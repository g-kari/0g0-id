/* global document, window, getComputedStyle */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.UI_REFERENCE_PLAYWRIGHT_MODULE || "@playwright/test");
const staticRoot = path.resolve("workers/admin/dist/client");
const reportDir = path.resolve(process.env.UI_REFERENCE_REPORT_DIR || "ui-reference-report");
const metrics = {
  total_users: 1284,
  active_sessions: 267,
  total_services: 18,
  admin_users: 6,
  banned_users: 12,
  recent_logins_24h: 438,
  recent_logins_7d: 2916,
};
const report = {
  status: "running",
  scope:
    "Built admin UI; synthetic metrics; all non-loopback requests blocked; no production API or writable server",
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
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
    { width: 390, height: 320 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.addEventListener("pageshow", (event) => {
        window.__uiReferencePersisted = event.persisted;
      });
    });
    const errors = [],
      blockedOrigins = [],
      unexpectedWrites = [];
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
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: [] }),
        });
        return;
      }
      await route.continue();
    });
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
      assert.equal(await page.locator("#admin-workspace").evaluate((el) => el.inert), false);
      assert.equal(await page.locator("#sidebar").evaluate((el) => el.inert), false);
      await page.setViewportSize(viewport);
      assert.equal(await page.locator("#sidebar").evaluate((el) => el.inert), true);
      await page.locator("#hamburger").click();
      await page.locator('#sidebar a[href="/services"]').click();
      await page.waitForURL("**/services");
      await page.goBack();
      await page.waitForURL("**/dashboard");
      assert.equal(await page.locator("#hamburger").getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator("#admin-workspace").evaluate((el) => el.inert), false);
      await page.goForward();
      await page.waitForURL("**/services");
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
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedWrites, []);
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
