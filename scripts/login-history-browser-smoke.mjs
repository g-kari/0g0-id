/* global document, window, MouseEvent */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const playwrightModule = process.env.LOGIN_HISTORY_PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  throw new Error(
    "Set LOGIN_HISTORY_PLAYWRIGHT_MODULE to the disposable @playwright/test install.",
  );
}
const require = createRequire(import.meta.url);
const { chromium, expect } = require(playwrightModule);
const playwrightVersion = require(path.join(playwrightModule, "package.json")).version;
assert.equal(playwrightVersion, "1.57.0", "Use the CI-pinned browser test toolchain.");
const staticRoot = path.resolve("workers/user/dist/client");
const reportDir = path.resolve(process.env.LOGIN_HISTORY_REPORT_DIR || "login-history-ui");
const history = (provider, count = 50) =>
  Array.from({ length: count }, (_, i) => ({
    id: `synthetic-${provider}-${i}`,
    user_id: "synthetic-user",
    provider,
    ip_address: "192.0.2.1",
    country: "JP",
    user_agent: `Synthetic ${provider} browser ${i}`,
    created_at: "2026-10-03T00:00:00Z",
  }));
const report = {
  sourceCommit: process.env.GITHUB_SHA || null,
  runId: process.env.GITHUB_RUN_ID || null,
  node: process.version,
  playwright: playwrightVersion,
  scope:
    "Actual built static login-history UI; synthetic GET responses only; exact-origin network guard",
  cases: [],
  status: "running",
};

async function main() {
  await mkdir(reportDir, { recursive: true });
  report.loginHistoryHtmlSha256 = createHash("sha256")
    .update(await readFile(path.join(staticRoot, "login-history/index.html")))
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
    browser = await chromium.launch({
      headless: true,
      ...(process.env.LOGIN_HISTORY_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.LOGIN_HISTORY_CHROMIUM_EXECUTABLE }
        : {}),
    });
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
        // Abort all non-fixture origins, including external fonts.
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
          if (url.pathname === "/api/me/login-history") {
            calls[calls.length - 1].provider = url.searchParams.get("provider") || "";
            calls[calls.length - 1].offset = Number(url.searchParams.get("offset"));
            calls[calls.length - 1].limit = Number(url.searchParams.get("limit"));
            await respond(route, calls.length, url);
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
        await check(page, calls, origin);
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
        "Initial failure, keyboard retry, repeated failure and successful recovery",
        viewport,
        async (route, n) => {
          if (n <= 2) {
            if (n === 2) await retryGate;
            await route.fulfill({
              status: 503,
              json: { error: { code: "UNAVAILABLE", message: "Synthetic unavailable" } },
            });
          } else await route.fulfill({ json: { data: history("google", 1) } });
        },
        async (page, calls, origin) => {
          await page.goto(`${origin}/login-history`);
          const retry = page.getByRole("button", { name: "もう一度読み込む" });
          await expect(page.getByRole("alert")).toContainText("ログイン履歴の取得に失敗");
          await expect(retry).toBeEnabled();
          await page.waitForTimeout(600);
          assert.equal(calls.length, 1, "No automatic history retry");
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            true,
            "Recovery panel fits a narrow viewport",
          );
          await page.screenshot({ path: path.join(reportDir, `error-${viewport.width}.png`) });
          await retry.press("Enter");
          await expect(page.locator("#history-results")).toHaveAttribute("aria-busy", "true");
          await expect(retry).toBeDisabled();
          await page.evaluate(() => {
            document.getElementById("retry-btn").dispatchEvent(new MouseEvent("click"));
            document.getElementById("retry-btn").dispatchEvent(new MouseEvent("click"));
          });
          await page.waitForTimeout(100);
          assert.equal(calls.length, 2, "Pending retry is deduplicated");
          finishRetry();
          await expect(page.getByRole("alert")).toBeVisible();
          await expect(retry).toBeFocused();
          await retry.press("Space");
          await expect(page.locator("#history-summary")).toContainText("1 件");
          await expect(page.locator("#history-summary")).toBeFocused();
          await expect(page.locator("#list")).toContainText("google");
          await expect(page.locator("#error")).toBeHidden();
          await expect(page.locator("#history-results")).toHaveAttribute("aria-busy", "false");
          assert.deepEqual(
            calls.map((c) => [c.provider, c.offset, c.limit]),
            [
              ["", 0, 50],
              ["", 0, 50],
              ["", 0, 50],
            ],
          );
          await page.screenshot({ path: path.join(reportDir, `recovered-${viewport.width}.png`) });
        },
      );

      let finishAppend;
      const appendGate = new Promise((resolve) => {
        finishAppend = resolve;
      });
      await scenario(
        "Next-page failure preserves rows and offset; repeated clicks; last-page focus",
        viewport,
        async (route, n) => {
          if (n === 2)
            await route.fulfill({
              status: 500,
              json: { error: { message: "Synthetic page failure" } },
            });
          else {
            if (n === 3) await appendGate;
            await route.fulfill({
              json: { data: n === 1 ? history("google") : n === 3 ? history("github") : [] },
            });
          }
        },
        async (page, calls, origin) => {
          await page.goto(`${origin}/login-history`);
          await expect(page.locator("#history-summary")).toContainText("50 件");
          const more = page.getByRole("button", { name: "もっと読み込む" });
          await more.press("Enter");
          await expect(page.getByRole("alert")).toContainText("表示中の履歴はそのまま");
          await expect(page.locator("#list > div")).toHaveCount(50);
          await expect(page.locator("#list")).toContainText("Synthetic google browser 49");
          const retry = page.getByRole("button", { name: "もう一度読み込む" });
          await retry.press("Enter");
          await page.evaluate(() => {
            document.getElementById("retry-btn").dispatchEvent(new MouseEvent("click"));
            document.getElementById("load-more-btn").dispatchEvent(new MouseEvent("click"));
          });
          await page.waitForTimeout(100);
          assert.equal(calls.length, 3);
          finishAppend();
          await expect(page.locator("#history-summary")).toContainText("100 件");
          await expect(page.locator("#list > div")).toHaveCount(100);
          await more.press("Space");
          await expect(page.locator("#load-more-wrap")).toBeHidden();
          await expect(page.locator("#history-summary")).toContainText(
            "すべての履歴を読み込みました",
          );
          await expect(page.locator("#history-summary")).toBeFocused();
          assert.deepEqual(
            calls.map((c) => c.offset),
            [0, 50, 50, 100],
          );
        },
      );

      let finishOld;
      const oldGate = new Promise((resolve) => {
        finishOld = resolve;
      });
      await scenario(
        "Rapid provider changes ignore stale reads and recover from empty state",
        viewport,
        async (route, n, url) => {
          const provider = url.searchParams.get("provider") || "";
          if (n <= 2) {
            await oldGate;
            await route.fulfill({ json: { data: history(provider || "google") } }).catch(() => {});
          } else
            await route.fulfill({
              json: { data: provider === "line" ? [] : history(provider, 2) },
            });
        },
        async (page, calls, origin) => {
          await page.goto(`${origin}/login-history`);
          const provider = page.getByLabel("プロバイダー");
          await expect.poll(() => calls.length).toBe(1);
          await provider.selectOption("google");
          await expect.poll(() => calls.length).toBe(2);
          await provider.selectOption("github");
          await expect(page.locator("#history-summary")).toContainText("github の履歴を 2 件");
          finishOld();
          await page.waitForTimeout(150);
          await expect(page.locator("#list > div")).toHaveCount(2);
          await expect(page.locator("#list")).not.toContainText("google");
          await expect(page.locator("#error")).toBeHidden();
          await provider.selectOption("line");
          await expect(page.locator("#empty")).toHaveText("line のログイン履歴はありません");
          await expect(page.locator("#list")).toBeHidden();
          await expect(page.locator("#history-results")).toHaveAttribute("aria-busy", "false");
          await provider.selectOption("github");
          await expect(page.locator("#history-summary")).toContainText("github の履歴を 2 件");
          assert.deepEqual(
            calls.map((c) => [c.provider, c.offset]),
            [
              ["", 0],
              ["google", 0],
              ["github", 0],
              ["line", 0],
              ["github", 0],
            ],
          );
          await page.screenshot({ path: path.join(reportDir, `filtered-${viewport.width}.png`) });
          await page.goto(`${origin}/favicon.svg`);
          await page.goBack();
          await expect(page.locator("#loading")).toBeHidden();
          await expect(page.locator("#error")).toBeHidden();
          await expect(page.locator("#history-results")).toHaveAttribute("aria-busy", "false");
          const selected = await provider.inputValue();
          await expect(page.locator("#history-summary")).toContainText(
            selected ? `${selected} の履歴を` : "ログイン履歴を",
          );
        },
      );
    }

    await scenario(
      "Network failure recovers without a page reload",
      { width: 320, height: 740 },
      async (route, n) => {
        if (n === 1) await route.abort("failed");
        else await route.fulfill({ json: { data: [] } });
      },
      async (page, calls, origin) => {
        await page.goto(`${origin}/login-history`);
        await expect(page.getByRole("alert")).toBeVisible();
        await page.getByRole("button", { name: "もう一度読み込む" }).press("Enter");
        await expect(page.locator("#empty")).toBeVisible();
        await expect(page.locator("#history-summary")).toBeFocused();
        assert.equal(calls.length, 2);
      },
    );

    await scenario(
      "Expired session preserves the existing login redirect",
      { width: 1280, height: 900 },
      (route) => route.fulfill({ status: 401, json: { error: { message: "Unauthorized" } } }),
      async (page, calls, origin) => {
        await page.goto(`${origin}/login-history`);
        await expect(page).toHaveURL(`${origin}/`);
        await expect(page.getByRole("link", { name: "Googleでサインイン" })).toBeVisible();
        assert.equal(calls.length, 1);
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
  console.log(`Login history UI: ${report.cases.length} synthetic browser cases passed`);
}

await main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
