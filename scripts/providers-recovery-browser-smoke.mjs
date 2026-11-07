/* global document, window, MouseEvent */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const playwrightModule = process.env.PROVIDERS_RECOVERY_PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  throw new Error(
    "Set PROVIDERS_RECOVERY_PLAYWRIGHT_MODULE to the existing @playwright/test install.",
  );
}
const require = createRequire(import.meta.url);
const { chromium, expect } = require(playwrightModule);
const playwrightVersion = require(path.join(playwrightModule, "package.json")).version;
assert.equal(playwrightVersion, "1.57.0", "Use the CI-pinned browser test toolchain.");
const staticRoot = path.resolve("workers/user/dist/client");
const reportDir = path.resolve(
  process.env.PROVIDERS_RECOVERY_REPORT_DIR || "providers-recovery-ui",
);
const providersPath = "/api/providers";
const providerLabels = {
  google: "Google",
  line: "LINE",
  twitch: "Twitch",
  github: "GitHub",
  x: "X（Twitter）",
};
const profile = {
  id: "synthetic-user",
  email: "synthetic@example.invalid",
  name: "Synthetic profile",
  picture: null,
  phone: null,
  address: null,
  role: "user",
};
const report = {
  sourceCommit: process.env.GITHUB_SHA || null,
  runId: process.env.GITHUB_RUN_ID || null,
  node: process.version,
  playwright: playwrightVersion,
  scope:
    "Actual built static SNS providers UI; synthetic GET responses only; exact-origin network guard; no provider link/unlink flows",
  cases: [],
  status: "running",
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function statuses(connected = ["google"]) {
  return Object.keys(providerLabels).map((provider) => ({
    provider,
    connected: connected.includes(provider),
  }));
}

async function fail(route, message = "一時的なエラーです", status = 503) {
  // Ordinary errors do not activate the shared TOKEN_ROTATED/DBSC transport retries.
  await route.fulfill({
    status,
    json: { error: { code: "SYNTHETIC_PROVIDERS_FAILURE", message } },
  });
}

async function shell(page) {
  await expect(page.getByRole("heading", { name: "SNS連携", exact: true })).toBeVisible();
  await expect(page.locator("#providers-heading")).toHaveAttribute("tabindex", "-1");
  await expect(page.locator('a[href="/profile"]')).toBeVisible();
  await expect(page.locator("#loading")).toHaveAttribute("role", "status");
  await expect(page.locator("#providers-error-message")).toHaveAttribute("role", "alert");
  await expect(page.locator("#providers-retry-btn")).toHaveAttribute("type", "button");
}

async function failed(page, message) {
  await shell(page);
  await expect(page.locator("#providers-state")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#providers-error")).toBeVisible();
  if (message) await expect(page.locator("#providers-error-message")).toHaveText(message);
  else await expect(page.locator("#providers-error-message")).not.toBeEmpty();
  await expect(page.locator("#loading")).toBeHidden();
  await expect(page.locator("#provider-list")).toBeHidden();
  await expect(page.locator("#warning")).toBeHidden();
  await expect(page.getByRole("button", { name: "もう一度読み込む", exact: true })).toBeEnabled();
}

async function pending(page) {
  await shell(page);
  await expect(page.locator("#providers-state")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#loading")).toBeVisible();
  await expect(page.locator("#provider-list")).toBeHidden();
  await expect(page.locator("#warning")).toBeHidden();
  await expect(page.locator("#providers-retry-btn")).toBeDisabled();
}

async function loaded(page, data) {
  await shell(page);
  await expect(page.locator("#providers-state")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#loading")).toBeHidden();
  await expect(page.locator("#providers-error")).toBeHidden();
  await expect(page.locator("#providers-error-message")).toBeEmpty();
  await expect(page.locator("#provider-list")).toBeVisible();
  const linked = data.filter((row) => row.connected).length;
  const rows = page.locator("#provider-list > div");
  await expect(rows).toHaveCount(data.length);
  for (let index = 0; index < data.length; index++) {
    const status = data[index];
    const row = rows.nth(index);
    await expect(row.getByText(providerLabels[status.provider], { exact: true })).toBeVisible();
    await expect(
      row.getByText(status.connected ? "連携済み" : "未連携", { exact: true }),
    ).toBeVisible();
    if (status.connected) {
      const unlink = row.locator(`[data-unlink="${status.provider}"]`);
      await expect(unlink).toHaveText("連携解除");
      if (linked <= 1) {
        await expect(unlink).toBeDisabled();
        await expect(unlink).toHaveAttribute("title", "最後の連携プロバイダーは解除できません");
      } else {
        await expect(unlink).toBeEnabled();
      }
      await expect(row.locator("form")).toHaveCount(0);
    } else {
      // Inspect the existing linking form without submitting it or starting OAuth.
      const form = row.locator("form");
      await expect(form).toHaveAttribute("method", "post");
      await expect(form).toHaveAttribute("action", "/auth/link");
      await expect(form.locator('input[name="provider"]')).toHaveAttribute("type", "hidden");
      await expect(form.locator('input[name="provider"]')).toHaveValue(status.provider);
      await expect(form.getByRole("button", { name: "連携する", exact: true })).toHaveAttribute(
        "type",
        "submit",
      );
      await expect(form.getByRole("button", { name: "連携する", exact: true })).toBeEnabled();
      await expect(row.locator("[data-unlink]")).toHaveCount(0);
    }
  }
  if (linked <= 1) {
    await expect(page.locator("#warning")).toBeVisible();
    await expect(page.locator("#warning")).toContainText("解除できません");
  } else {
    await expect(page.locator("#warning")).toBeHidden();
  }
}

async function noOverflow(page) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    "The providers and recovery panels must not overflow horizontally.",
  );
}

async function repeatedActivation(page) {
  await page.locator("#providers-retry-btn").press("Enter");
  await page.locator("#providers-retry-btn").press("Space");
  // A synthetic click bypasses native disabled-button suppression to test the handler guard.
  await page.evaluate(() => {
    const button = document.getElementById("providers-retry-btn");
    button.dispatchEvent(new MouseEvent("click"));
    button.dispatchEvent(new MouseEvent("click"));
  });
  await page.waitForTimeout(100);
}

async function main() {
  await mkdir(reportDir, { recursive: true });
  report.providersHtmlSha256 = createHash("sha256")
    .update(await readFile(path.join(staticRoot, "providers/index.html")))
    .digest("hex");
  const server = createServer(async (req, res) => {
    // No API proxies, credentials, production data, or writable routes exist in this fixture.
    let filename;
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (req.method !== "GET" || pathname.startsWith("/api/") || pathname.startsWith("/auth/")) {
        res.writeHead(405).end("Only static synthetic-fixture reads are permitted");
        return;
      }
      const relative =
        pathname === "/" || !path.extname(pathname) ? `${pathname}/index.html` : pathname;
      filename = path.resolve(staticRoot, `.${decodeURIComponent(relative)}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!filename.startsWith(`${staticRoot}${path.sep}`)) {
      res.writeHead(400).end();
      return;
    }
    try {
      const bytes = await readFile(filename);
      const contentType = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
      }[path.extname(filename)];
      res
        .writeHead(200, {
          "Content-Type": contentType || "application/octet-stream",
          "Cache-Control": "no-store",
        })
        .end(bytes);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PROVIDERS_RECOVERY_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PROVIDERS_RECOVERY_CHROMIUM_EXECUTABLE }
        : {}),
    });
    report.browser = await browser.version();
    report.browserExecutableOverride = process.env.PROVIDERS_RECOVERY_CHROMIUM_EXECUTABLE || null;

    async function scenario(name, viewport, respond, check, allowedPaths = [providersPath]) {
      const context = await browser.newContext({
        viewport,
        serviceWorkers: "block",
        timezoneId: "UTC",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const calls = [];
      const pageErrors = [];
      const forbiddenWrites = [];
      const unexpectedReads = [];
      const unexpectedDialogs = [];
      const unexpectedSockets = [];
      const blockedOrigins = new Set();
      page.on("pageerror", (err) => pageErrors.push(err.message));
      page.on("dialog", async (dialog) => {
        unexpectedDialogs.push({ type: dialog.type(), message: dialog.message() });
        await dialog.dismiss();
      });
      await context.routeWebSocket("**/*", async (socket) => {
        unexpectedSockets.push(socket.url());
        await socket.close();
      });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() !== "GET") {
          forbiddenWrites.push({
            method: request.method(),
            origin: url.origin,
            path: url.pathname,
          });
          await route.abort();
          return;
        }
        // Abort every non-fixture origin, including the layout's external fonts.
        if (url.origin !== origin) {
          blockedOrigins.add(url.origin);
          await route.abort();
          return;
        }
        if (url.pathname.startsWith("/auth/")) {
          unexpectedReads.push(url.pathname);
          await route.abort();
          return;
        }
        if (url.pathname.startsWith("/api/")) {
          if (!allowedPaths.includes(url.pathname) || url.search) {
            unexpectedReads.push(`${url.pathname}${url.search}`);
            await route.abort();
            return;
          }
          const call = {
            method: request.method(),
            path: url.pathname,
            index: calls.filter((entry) => entry.path === url.pathname).length + 1,
          };
          calls.push(call);
          await respond(route, call);
          return;
        }
        await route.continue();
      });
      const caseReport = {
        name,
        viewport,
        calls,
        pageErrors,
        forbiddenWrites,
        unexpectedReads,
        unexpectedDialogs,
        unexpectedSockets,
        status: "running",
      };
      report.cases.push(caseReport);
      const readCount = () => calls.filter((call) => call.path === providersPath).length;
      try {
        await check(page, readCount, origin);
        assert.deepEqual(forbiddenWrites, [], "No account or provider writes may occur.");
        assert.deepEqual(
          unexpectedReads,
          [],
          "Only the exact synthetic API read routes may occur.",
        );
        assert.deepEqual(unexpectedDialogs, [], "No provider link/unlink flow may be invoked.");
        assert.deepEqual(unexpectedSockets, [], "No WebSocket traffic may occur.");
        assert.deepEqual(pageErrors, [], "No uncaught page errors may occur.");
        caseReport.status = "passed";
        console.log(`PASS ${viewport.width}px: ${name}`);
      } catch (err) {
        caseReport.status = "failed";
        caseReport.error = err instanceof Error ? err.stack : String(err);
        await page
          .screenshot({
            path: path.join(reportDir, `failed-${report.cases.length}-${viewport.width}.png`),
            fullPage: true,
          })
          .catch(() => {});
        throw err;
      } finally {
        caseReport.blockedOrigins = [...blockedOrigins];
        await context.close();
      }
    }

    for (const viewport of [
      { width: 320, height: 740 },
      { width: 1280, height: 900 },
    ]) {
      const retryGate = deferred();
      const recoveryGate = deferred();
      await scenario(
        "Persistent HTTP failure, Enter/Space recovery and single-flight retry",
        viewport,
        async (route, call) => {
          if (call.index === 1) return fail(route);
          if (call.index === 2) {
            await retryGate.promise;
            return fail(route, "再度失敗しました", 500);
          }
          await recoveryGate.promise;
          return route.fulfill({ json: { data: statuses() } });
        },
        async (page, readCount, localOrigin) => {
          try {
            await page.goto(`${localOrigin}/providers`);
            await failed(page, "一時的なエラーです");
            await page.waitForTimeout(3500);
            await failed(page, "一時的なエラーです");
            assert.equal(readCount(), 1, "A failed initial read must not retry automatically.");
            await noOverflow(page);
            await page.screenshot({ path: path.join(reportDir, `error-${viewport.width}.png`) });
            const retry = page.locator("#providers-retry-btn");
            await retry.press("Enter");
            await pending(page);
            await repeatedActivation(page);
            assert.equal(readCount(), 2, "An in-flight retry must be deduplicated.");
            retryGate.resolve();
            await failed(page, "再度失敗しました");
            await expect(retry).toBeFocused();
            assert.equal(readCount(), 2);
            await retry.press("Space");
            await pending(page);
            await repeatedActivation(page);
            assert.equal(readCount(), 3, "A second in-flight retry must also be deduplicated.");
            recoveryGate.resolve();
            await loaded(page, statuses());
            await expect(page.locator("#providers-heading")).toBeFocused();
            assert.equal(readCount(), 3);
            await noOverflow(page);
            await page.screenshot({
              path: path.join(reportDir, `recovered-${viewport.width}.png`),
              fullPage: true,
            });
            const before = await page.locator("#provider-list").innerHTML();
            await page.evaluate(() =>
              document.getElementById("providers-retry-btn").dispatchEvent(new MouseEvent("click")),
            );
            await page.waitForTimeout(100);
            assert.equal(
              readCount(),
              3,
              "A loaded list must not fetch again through hidden Retry.",
            );
            assert.equal(await page.locator("#provider-list").innerHTML(), before);
          } finally {
            retryGate.resolve();
            recoveryGate.resolve();
          }
        },
      );

      await scenario(
        "Initial success preserves focus, linking forms and multi-provider guard",
        viewport,
        (route) => route.fulfill({ json: { data: statuses(["google", "github"]) } }),
        async (page, readCount, localOrigin) => {
          await page.goto(`${localOrigin}/providers`);
          await loaded(page, statuses(["google", "github"]));
          assert.equal(await page.evaluate(() => document.activeElement.tagName), "BODY");
          assert.equal(readCount(), 1);
          await noOverflow(page);
          await page.screenshot({
            path: path.join(reportDir, `initial-success-${viewport.width}.png`),
            fullPage: true,
          });
        },
      );

      const initialGate = deferred();
      await scenario(
        "Pending initial read retains profile escape and does not steal focus",
        viewport,
        async (route) => {
          await initialGate.promise;
          await route.fulfill({ json: { data: statuses() } });
        },
        async (page, readCount, localOrigin) => {
          try {
            await page.goto(`${localOrigin}/providers`, { waitUntil: "domcontentloaded" });
            await pending(page);
            await expect(page.locator("#providers-error")).toBeHidden();
            await expect.poll(readCount).toBe(1);
            await page.evaluate(() => {
              const retry = document.getElementById("providers-retry-btn");
              retry.dispatchEvent(new MouseEvent("click"));
              retry.dispatchEvent(new MouseEvent("click"));
            });
            const back = page.locator('a[href="/profile"]');
            await back.focus();
            initialGate.resolve();
            await loaded(page, statuses());
            await expect(back).toBeFocused();
            assert.equal(readCount(), 1, "The initial in-flight read must also be guarded.");
          } finally {
            initialGate.resolve();
          }
        },
      );

      const movedFocusGate = deferred();
      await scenario(
        "Successful explicit retry does not steal focus after the person moves away",
        viewport,
        async (route, call) => {
          if (call.index === 1) return fail(route);
          await movedFocusGate.promise;
          return route.fulfill({ json: { data: statuses() } });
        },
        async (page, readCount, localOrigin) => {
          try {
            await page.goto(`${localOrigin}/providers`);
            await failed(page, "一時的なエラーです");
            await page.locator("#providers-retry-btn").press("Enter");
            await pending(page);
            const back = page.locator('a[href="/profile"]');
            await back.focus();
            movedFocusGate.resolve();
            await loaded(page, statuses());
            await expect(back).toBeFocused();
            assert.equal(readCount(), 2);
          } finally {
            movedFocusGate.resolve();
          }
        },
      );

      const pointerGate = deferred();
      await scenario(
        "Retry completion respects a pointer interaction on nonfocusable content",
        viewport,
        async (route, call) => {
          if (call.index === 1) return fail(route);
          await pointerGate.promise;
          return route.fulfill({ json: { data: statuses() } });
        },
        async (page, readCount, localOrigin) => {
          try {
            await page.goto(`${localOrigin}/providers`);
            await failed(page, "一時的なエラーです");
            await page.locator("#providers-retry-btn").press("Enter");
            await pending(page);
            await page
              .getByText("複数のSNSアカウントを同一IDに連携できます", { exact: true })
              .click();
            const focus = await page.evaluate(() => ({
              id: document.activeElement.id,
              tagName: document.activeElement.tagName,
            }));
            pointerGate.resolve();
            await loaded(page, statuses());
            assert.deepEqual(
              await page.evaluate(() => ({
                id: document.activeElement.id,
                tagName: document.activeElement.tagName,
              })),
              focus,
              "A pointer interaction elsewhere must prevent retry focus restoration.",
            );
            await expect(page.locator("#providers-heading")).not.toBeFocused();
            assert.equal(readCount(), 2);
          } finally {
            pointerGate.resolve();
          }
        },
      );

      await scenario(
        "Network failure retains persistent recovery and a working profile escape",
        viewport,
        (route, call) =>
          call.path === providersPath
            ? route.abort("failed")
            : route.fulfill({ json: { data: profile } }),
        async (page, readCount, localOrigin) => {
          await page.goto(`${localOrigin}/providers`);
          await failed(page);
          await noOverflow(page);
          assert.equal(readCount(), 1);
          await page.locator('a[href="/profile"]').click();
          await expect(page).toHaveURL(`${localOrigin}/profile`);
          await expect(page.locator("#content")).toBeVisible();
          await expect(page.locator("#name")).toHaveValue(profile.name);
          await expect(page.locator("#user-email")).toHaveText(profile.email);
          assert.equal(readCount(), 1);
        },
        [providersPath, "/api/me"],
      );

      await scenario(
        "Existing unauthorized navigation remains intact",
        viewport,
        (route) => route.fulfill({ status: 401, json: { error: { code: "UNAUTHORIZED" } } }),
        async (page, readCount, localOrigin) => {
          await page.goto(`${localOrigin}/providers`);
          await expect(page).toHaveURL(`${localOrigin}/`);
          await expect(page.getByRole("link", { name: "Googleでサインイン" })).toBeVisible();
          assert.equal(readCount(), 1);
        },
      );
    }
    report.status = "passed";
  } catch (err) {
    report.status = "failed";
    report.error = err instanceof Error ? err.stack : String(err);
    throw err;
  } finally {
    await writeFile(path.join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  console.log(`Providers recovery UI: ${report.cases.length} synthetic browser cases passed`);
}

await main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
