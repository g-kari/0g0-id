/* global document, window, MouseEvent */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const playwrightModule = process.env.PROFILE_RECOVERY_PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  throw new Error(
    "Set PROFILE_RECOVERY_PLAYWRIGHT_MODULE to the disposable @playwright/test install.",
  );
}
const require = createRequire(import.meta.url);
const { chromium, expect } = require(playwrightModule);
const playwrightVersion = require(path.join(playwrightModule, "package.json")).version;
assert.equal(playwrightVersion, "1.57.0", "Use the CI-pinned browser test toolchain.");
const staticRoot = path.resolve("workers/user/dist/client");
const reportDir = path.resolve(process.env.PROFILE_RECOVERY_REPORT_DIR || "profile-recovery-ui");
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
  scope: "Actual built static profile UI; synthetic GET responses only; exact-origin network guard",
  cases: [],
  status: "running",
};

async function main() {
  await mkdir(reportDir, { recursive: true });
  report.profileHtmlSha256 = createHash("sha256")
    .update(await readFile(path.join(staticRoot, "profile/index.html")))
    .digest("hex");
  const server = createServer(async (req, res) => {
    // The server has no writable API routes, proxies, production data, or credentials.
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (req.method !== "GET" || pathname.startsWith("/api/")) {
      res.writeHead(405).end("Only static synthetic-fixture reads are permitted");
      return;
    }
    const relative =
      pathname === "/" || !path.extname(pathname) ? `${pathname}/index.html` : pathname;
    const filename = path.resolve(staticRoot, `.${decodeURIComponent(relative)}`);
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
    browser = await chromium.launch({ headless: true });
    report.browser = await browser.version();

    async function scenario(name, viewport, respond, check) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const calls = [];
      const pageErrors = [];
      const forbiddenWrites = [];
      const unexpectedReads = [];
      const blockedOrigins = new Set();
      page.on("pageerror", (err) => pageErrors.push(err.message));
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        // Abort all non-fixture origins, including fonts and any profile image URL.
        if (url.origin !== origin) {
          blockedOrigins.add(url.origin);
          await route.abort();
          return;
        }
        if (request.method() !== "GET") {
          forbiddenWrites.push({ method: request.method(), path: url.pathname });
          await route.abort();
          return;
        }
        if (url.pathname.startsWith("/api/")) {
          calls.push({ method: request.method(), path: url.pathname });
          if (url.pathname === "/api/me") {
            await respond(route, calls.filter((c) => c.path === "/api/me").length);
          } else if (["/api/me/bff-sessions", "/api/me/sessions"].includes(url.pathname)) {
            await route.fulfill({ json: { data: [] } });
          } else {
            unexpectedReads.push(url.pathname);
            await route.abort();
          }
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
        status: "running",
      };
      report.cases.push(caseReport);
      try {
        await check(page, () => calls.filter((c) => c.path === "/api/me").length, origin);
        assert.deepEqual(forbiddenWrites, [], "No account writes may occur.");
        assert.deepEqual(
          unexpectedReads,
          [],
          "Only the exact synthetic API read routes may occur.",
        );
        assert.deepEqual(pageErrors, [], "No uncaught page errors may occur.");
        caseReport.status = "passed";
      } finally {
        caseReport.blockedOrigins = [...blockedOrigins];
        await context.close();
      }
    }

    for (const viewport of [
      { width: 320, height: 740 },
      { width: 1280, height: 900 },
    ]) {
      let finishRetry;
      const retryGate = new Promise((resolve) => {
        finishRetry = resolve;
      });
      await scenario(
        "HTTP failure, guarded keyboard retry, repeated failure and recovery",
        viewport,
        async (route, n) => {
          if (n === 1) {
            await route.fulfill({
              status: 503,
              json: { error: { code: "TEMPORARY_UNAVAILABLE", message: "一時的なエラーです" } },
            });
          } else if (n === 2) {
            await retryGate;
            await route.fulfill({
              status: 500,
              json: { error: { code: "TEMPORARY_UNAVAILABLE", message: "再度失敗しました" } },
            });
          } else {
            await route.fulfill({ json: { data: profile } });
          }
        },
        async (page, readCount, origin) => {
          await page.goto(`${origin}/profile`);
          await expect(page.locator("#profile-error")).toBeVisible();
          await expect(page.getByRole("alert")).toHaveText("一時的なエラーです");
          const retry = page.getByRole("button", { name: "もう一度読み込む" });
          await expect(retry).toBeEnabled();
          await page.waitForTimeout(3500);
          await expect(page.locator("#profile-error")).toBeVisible();
          assert.equal(readCount(), 1, "No automatic read retry.");
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            true,
            "The recovery panel must not overflow horizontally.",
          );
          await page.screenshot({ path: path.join(reportDir, `error-${viewport.width}.png`) });
          await retry.press("Enter");
          await expect(page.getByRole("status")).toBeVisible();
          await expect(page.locator("#profile-retry-btn")).toBeDisabled();
          await page.evaluate(() => {
            const button = document.getElementById("profile-retry-btn");
            button.dispatchEvent(new MouseEvent("click"));
            button.dispatchEvent(new MouseEvent("click"));
          });
          await page.waitForTimeout(100);
          assert.equal(readCount(), 2, "An in-flight retry must be deduplicated.");
          finishRetry();
          await expect(page.getByRole("alert")).toHaveText("再度失敗しました");
          await expect(retry).toBeFocused();
          await retry.press("Space");
          await expect(page.locator("#content")).toBeVisible();
          await expect(page.locator("#name")).toHaveValue(profile.name);
          await expect(page.locator("#name")).toBeFocused();
          await expect(page.locator("#user-email")).toHaveText(profile.email);
          await expect(page.locator("#profile-error")).toBeHidden();
          await expect(page.locator("#loading")).toBeHidden();
          assert.equal(readCount(), 3);
          for (const target of [
            "/sessions",
            "/connections",
            "/providers",
            "/login-history",
            "/login-stats",
          ]) {
            await expect(page.locator(`#content a[href="${target}"]`)).toBeVisible();
          }
          await page.locator("#name").fill("Unsaved synthetic edit");
          await page.evaluate(() =>
            document.getElementById("profile-retry-btn").dispatchEvent(new MouseEvent("click")),
          );
          await expect(page.locator("#name")).toHaveValue("Unsaved synthetic edit");
          assert.equal(readCount(), 3, "An already loaded form must not be overwritten.");
          await page.screenshot({
            path: path.join(reportDir, `recovered-${viewport.width}.png`),
            fullPage: true,
          });
          await page.getByRole("link", { name: "セッション管理", exact: true }).click();
          await expect(page).toHaveURL(`${origin}/sessions`);
          await page.goBack();
          await expect(page).toHaveURL(`${origin}/profile`);
          await expect(page.locator("#content")).toBeVisible();
          await expect(page.locator("#save-btn")).toBeEnabled();
          // Open and cancel only; never submit an account mutation.
          await page.locator("#delete-account-btn").click();
          await expect(page.locator("#delete-dialog")).toBeVisible();
          await page.locator("#delete-cancel-btn").click();
          await expect(page.locator("#delete-dialog")).toBeHidden();
        },
      );
    }

    await scenario(
      "Initial success does not steal focus",
      { width: 390, height: 844 },
      (route) => route.fulfill({ json: { data: profile } }),
      async (page, readCount, origin) => {
        await page.goto(`${origin}/profile`);
        await expect(page.locator("#content")).toBeVisible();
        await expect(page.locator("#name")).toHaveValue(profile.name);
        assert.equal(await page.evaluate(() => document.activeElement.tagName), "BODY");
        assert.equal(readCount(), 1);
      },
    );
    await scenario(
      "Existing unauthorized navigation remains intact",
      { width: 390, height: 844 },
      (route) => route.fulfill({ status: 401, json: { error: { code: "UNAUTHORIZED" } } }),
      async (page, readCount, origin) => {
        await page.goto(`${origin}/profile`);
        await expect(page).toHaveURL(`${origin}/`);
        await expect(page.getByRole("link", { name: "Googleでサインイン" })).toBeVisible();
        assert.equal(readCount(), 1);
      },
    );
    await scenario(
      "Network failure retains a working top-page escape",
      { width: 320, height: 740 },
      (route) => route.abort("failed"),
      async (page, readCount, origin) => {
        await page.goto(`${origin}/profile`);
        await expect(page.locator("#profile-error")).toBeVisible();
        await page.getByRole("link", { name: "トップへ戻る" }).click();
        await expect(page).toHaveURL(`${origin}/`);
        await expect(page.getByRole("link", { name: "Googleでサインイン" })).toBeVisible();
        assert.equal(readCount(), 1);
      },
    );
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
  console.log(`Profile recovery UI: ${report.cases.length} synthetic browser cases passed`);
}

await main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
