/* global navigator, window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Reuses the existing audit runner's built static server and pinned Chromium.
// All API data and clipboard outcomes are synthetic. No Worker or live API starts here.
export async function serviceOwnerSubBrowserCases({
  browser,
  expect,
  origin,
  staticRoot,
  reportDir,
}) {
  const service = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Synthetic owner-sub service",
    client_id: "synthetic-owner-client",
    owner_user_id: "22222222-2222-4222-8222-222222222222",
    allowed_scopes: '["profile"]',
    created_at: "2026-10-16T00:00:00Z",
  };
  const subject = {
    service_id: service.id,
    client_id: service.client_id,
    owner_user_id: service.owner_user_id,
    sub: "a".repeat(64),
  };
  const apiPath = `/api/services/${service.id}`;
  const ownerPath = `${apiPath}/owner-sub`;
  const report = {
    sourceCommit: process.env.GITHUB_SHA || null,
    scope: "Actual built Astro service detail and bundled script; synthetic GET/clipboard only",
    htmlSha256: createHash("sha256")
      .update(await readFile(path.join(staticRoot, "services/detail/index.html")))
      .digest("hex"),
    cases: [],
    status: "running",
  };
  async function scenario(name, respond, check, viewport = { width: 390, height: 844 }) {
    const context = await browser.newContext({
      viewport,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const page = await context.newPage();
    const calls = [],
      unexpected = [],
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.routeWebSocket("**/*", (socket) => {
      unexpected.push(`WebSocket ${socket.url()}`);
      socket.close();
    });
    await context.addInitScript(() => {
      window.__ownerSubCopies = [];
      window.__ownerSubRejectCopy = false;
      window.__ownerSubXss = 0;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          async writeText(text) {
            if (window.__ownerSubRejectCopy) throw new Error("Synthetic clipboard denial");
            window.__ownerSubCopies.push(text);
          },
        },
      });
    });
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) {
        if (url.origin !== "https://fonts.googleapis.com" || url.pathname !== "/css2") {
          unexpected.push(`External ${url.origin}${url.pathname}`);
        }
        await route.abort();
        return;
      }
      if (request.method() !== "GET") {
        unexpected.push(`${request.method()} ${url.pathname}`);
        await route.abort();
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        calls.push({ path: url.pathname, query: url.search });
        if (url.pathname === apiPath) {
          await route.fulfill({ json: { data: service } });
          return;
        }
        if (url.pathname === `${apiPath}/redirect-uris` || url.pathname === `${apiPath}/users`) {
          await route.fulfill({ json: { data: [] } });
          return;
        }
        if (url.pathname === ownerPath && !url.search) {
          await respond(route, calls.filter((call) => call.path === ownerPath).length);
          return;
        }
        unexpected.push(`Unexpected API ${url.pathname}${url.search}`);
        await route.abort();
        return;
      }
      if (
        url.pathname === "/services/detail" ||
        url.pathname.startsWith("/_astro/") ||
        /^\/favicon\.(svg|ico)$/.test(url.pathname)
      ) {
        await route.continue();
        return;
      }
      unexpected.push(`Unexpected static read ${url.pathname}`);
      await route.abort();
    });
    const result = { name, calls, unexpected, errors, status: "running" };
    report.cases.push(result);
    try {
      await page.goto(`${origin}/services/detail?id=${service.id}`);
      await expect(page.locator("#content")).toBeVisible();
      await expect(page.locator("#service-name")).toHaveText(service.name);
      await expect(page.locator("#btn-copy-owner-sub")).toBeDisabled();
      assert.equal(
        calls.filter((call) => call.path === ownerPath).length,
        0,
        "No subject request before explicit click",
      );
      await check(page, calls);
      assert.deepEqual(unexpected, [], "Only allowlisted static/synthetic GET reads");
      assert.deepEqual(errors, [], "No uncaught browser errors");
      assert.equal(await page.evaluate(() => window.__ownerSubXss), 0);
      result.status = "passed";
    } catch (error) {
      result.status = "failed";
      result.error = error instanceof Error ? error.stack : String(error);
      throw error;
    } finally {
      await context.close();
    }
  }
  try {
    await scenario(
      "Built page wiring: explicit load and copy",
      (route) => route.fulfill({ json: { data: subject } }),
      async (page, calls) => {
        assert.deepEqual(await page.evaluate(() => window.__ownerSubCopies), []);
        await page.locator("#btn-load-owner-sub").click();
        await expect(page.locator("#owner-sub-value")).toHaveText(subject.sub);
        await expect(page.locator("#btn-copy-owner-sub")).toBeEnabled();
        assert.deepEqual(await page.evaluate(() => window.__ownerSubCopies), []);
        await page.locator("#btn-copy-owner-sub").click();
        await expect(page.locator("#owner-sub-status")).toHaveText("コピーしました。");
        assert.deepEqual(await page.evaluate(() => window.__ownerSubCopies), [subject.sub]);
        assert.equal(calls.filter((call) => call.path === ownerPath).length, 1);
        await page.screenshot({
          path: path.join(reportDir, "service-owner-sub-390.png"),
          fullPage: true,
        });
      },
    );
    await scenario(
      "GET failure stays local; retry recovers",
      (route, count) =>
        count === 1
          ? route.fulfill({
              status: 500,
              json: { error: { code: "INTERNAL_ERROR", message: "SYNTHETIC_PRIVATE_ERROR" } },
            })
          : route.fulfill({ json: { data: subject } }),
      async (page) => {
        await page.locator("#btn-load-owner-sub").click();
        await expect(page.locator("#owner-sub-status")).toContainText("取得に失敗しました");
        await expect(page.locator("#content")).toBeVisible();
        await expect(page.locator("#error")).toBeHidden();
        await expect(page.locator("#owner-sub-value")).toBeEmpty();
        await expect(page.locator("#btn-copy-owner-sub")).toBeDisabled();
        assert.equal(
          await page
            .locator("body")
            .textContent()
            .then((text) => text.includes("SYNTHETIC_PRIVATE_ERROR")),
          false,
        );
        await page.locator("#btn-load-owner-sub").click();
        await expect(page.locator("#owner-sub-value")).toHaveText(subject.sub);
      },
    );
    await scenario(
      "Clipboard denial preserves selectable text and permits retry",
      (route) => route.fulfill({ json: { data: subject } }),
      async (page) => {
        await page.locator("#btn-load-owner-sub").click();
        await expect(page.locator("#owner-sub-value")).toHaveText(subject.sub);
        await page.evaluate(() => {
          window.__ownerSubRejectCopy = true;
        });
        await page.locator("#btn-copy-owner-sub").click();
        await expect(page.locator("#owner-sub-status")).toContainText("表示された値を選択");
        await expect(page.locator("#owner-sub-value")).toHaveText(subject.sub);
        await expect(page.locator("#btn-copy-owner-sub")).toBeEnabled();
        await page.evaluate(() => {
          window.__ownerSubRejectCopy = false;
        });
        await page.locator("#btn-copy-owner-sub").click();
        await expect(page.locator("#owner-sub-status")).toHaveText("コピーしました。");
      },
    );
    for (const { label, result } of [
      { label: "changed owner", result: { ...subject, owner_user_id: service.id } },
      {
        label: "untrusted subject",
        result: { ...subject, sub: '<img src="/synthetic-xss" onerror="window.__ownerSubXss=1">' },
      },
    ])
      await scenario(
        `Reject ${label}`,
        (route) => route.fulfill({ json: { data: result } }),
        async (page) => {
          await page.locator("#btn-load-owner-sub").click();
          await expect(page.locator("#owner-sub-status")).toContainText("取得に失敗しました");
          await expect(page.locator("#owner-sub-value")).toBeEmpty();
          await expect(page.locator("#btn-copy-owner-sub")).toBeDisabled();
          await expect(page.locator("#owner-sub-value img, #owner-sub-value script")).toHaveCount(
            0,
          );
        },
      );
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await scenario(
      "Repeated clicks issue one GET while pending",
      async (route) => {
        await gate;
        await route.fulfill({ json: { data: subject } });
      },
      async (page, calls) => {
        try {
          await page.locator("#btn-load-owner-sub").click();
          await expect(page.locator("#owner-sub-status")).toHaveText("取得中…");
          await expect(page.locator("#btn-load-owner-sub")).toBeDisabled();
          await page.locator("#btn-load-owner-sub").dispatchEvent("click");
          await page.locator("#btn-copy-owner-sub").dispatchEvent("click");
          await expect.poll(() => calls.filter((call) => call.path === ownerPath).length).toBe(1);
        } finally {
          release();
        }
        await expect(page.locator("#owner-sub-value")).toHaveText(subject.sub);
        assert.deepEqual(await page.evaluate(() => window.__ownerSubCopies), []);
      },
      { width: 1280, height: 900 },
    );
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    await writeFile(
      path.join(reportDir, "service-owner-sub-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  console.log(
    `Service owner subject UI: ${report.cases.length} real-browser synthetic cases passed`,
  );
  return report;
}
