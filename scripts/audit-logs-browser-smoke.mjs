/* global document, window, MouseEvent, Event */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

// This runner never starts a Worker, reads credentials, or reaches a live API.
const playwrightModule = process.env.AUDIT_LOGS_PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  throw new Error("Set AUDIT_LOGS_PLAYWRIGHT_MODULE to the disposable @playwright/test install.");
}
const require = createRequire(import.meta.url);
const { chromium, expect } = require(playwrightModule);
const playwrightVersion = require(path.join(playwrightModule, "package.json")).version;
assert.equal(playwrightVersion, "1.57.0", "Use the CI-pinned browser test toolchain.");
const staticRoot = path.resolve("workers/admin/dist/client");
const reportDir = path.resolve(process.env.AUDIT_LOGS_REPORT_DIR || "audit-logs-ui");
const auditPath = "/api/audit-logs";
const viewports = [
  { width: 320, height: 740 },
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
];
const matchingFilters = {
  admin_user_id: "11111111-1111-4111-8111-111111111111",
  target_id: "22222222-2222-4222-8222-222222222222",
  action: "user.ban",
};
const otherAdmin = "33333333-3333-4333-8333-333333333333";
const otherTarget = "44444444-4444-4444-8444-444444444444";
const noMatchTarget = "55555555-5555-4555-8555-555555555555";
const deletedTarget = "66666666-6666-4666-8666-666666666666";
const malicious = '<img src="/synthetic-xss" onerror="window.__syntheticXss=1">';
const secret = "SYNTHETIC_PRIVATE_AUDIT_DETAILS_DO_NOT_RENDER";
const rawError = `${secret}: ${malicious}`;
const filterNames = ["admin_user_id", "target_id", "action"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function auditLog(i, overrides = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(1_000 - i).padStart(12, "0")}`,
    created_at: new Date(
      Date.parse("2026-10-02T12:00:00Z") - Math.min(i, 50) * 60_000,
    ).toISOString(),
    admin_user_id: matchingFilters.admin_user_id,
    action: matchingFilters.action,
    target_type: "user",
    target_id: matchingFilters.target_id,
    status: i === 51 ? "failure" : "success",
    // Deliberately present in the transport to catch accidental expansion/serialization.
    details: JSON.stringify({ access_token: secret, refresh_token: secret, payload: malicious }),
    ip_address: "192.0.2.99",
    ...overrides,
  };
}
const logs = [
  ...Array.from({ length: 51 }, (_, i) => auditLog(i + 1)),
  auditLog(52, { admin_user_id: otherAdmin }),
  auditLog(53, { target_id: otherTarget }),
  auditLog(54, { action: "user.unban" }),
  auditLog(55, { action: "service.delete", target_type: "service", target_id: otherTarget }),
  auditLog(56, { action: "user.delete", target_id: deletedTarget }),
];
const report = {
  sourceCommit: process.env.GITHUB_SHA || null,
  runId: process.env.GITHUB_RUN_ID || null,
  node: process.version,
  playwright: playwrightVersion,
  scope:
    "Compiled Astro audit-log UI; synthetic GET fixtures only; exact-origin/static-path guards",
  cases: [],
  status: "running",
};

function queryObject(url) {
  for (const key of url.searchParams.keys()) {
    assert.equal(url.searchParams.getAll(key).length, 1, `Query parameter ${key} must not repeat.`);
  }
  return Object.fromEntries(url.searchParams);
}
function filteredResponse(url) {
  const query = queryObject(url);
  for (const key of Object.keys(query)) {
    assert(["limit", "offset", ...filterNames].includes(key), `Unexpected audit read: ${key}`);
  }
  assert.equal(query.limit, "50", "The browser must use bounded 50-row reads.");
  assert.match(query.offset, /^\d+$/, "Every audit read must have a nonnegative integer offset.");
  const offset = Number(query.offset);
  assert(Number.isSafeInteger(offset));
  for (const key of ["admin_user_id", "target_id"]) {
    if (query[key] !== undefined) assert.match(query[key], uuidPattern);
  }
  if (query.action !== undefined) assert.match(query.action, /^[a-z]+\.[a-z_]+$/);
  const selected = logs.filter((row) =>
    filterNames.every((key) => !query[key] || row[key] === query[key]),
  );
  return {
    data: selected.slice(offset, offset + 50),
    pagination: { total: selected.length, limit: 50, offset },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function assertQuery(actual, expected, api = false) {
  const allowed = new Set([...filterNames, "offset", ...(api ? ["limit"] : [])]);
  for (const key of Object.keys(actual))
    assert(allowed.has(key), `Unexpected query parameter: ${key}`);
  for (const key of filterNames) {
    assert.equal(actual[key] || "", expected[key] || "", `${key} must match the applied query.`);
    if (!expected[key]) assert.equal(actual[key], undefined, "Empty filters must be omitted.");
  }
  assert.equal(
    actual.offset || "0",
    String(expected.offset || 0),
    "The filtered offset must be preserved.",
  );
  if (api) assert.equal(actual.limit, "50");
  else if (!expected.offset)
    assert.equal(actual.offset, undefined, "The first page must use the canonical URL.");
}
function readCount(calls) {
  return calls.filter((call) => call.path === auditPath).length;
}
function applyButton(page) {
  return page.locator('#filter-form button[type="submit"]');
}
async function fillFilters(page, filters) {
  await page.locator("#filter-admin").fill(filters.admin_user_id || "");
  await page.locator("#filter-target").fill(filters.target_id || "");
  await page.locator("#filter-action").fill(filters.action || "");
}
async function loaded(page, count) {
  await expect(page.locator("#table-wrap")).toBeVisible();
  await expect(page.locator("#loading")).toBeHidden();
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#audit-tbody tr")).toHaveCount(count);
}
async function assertState(page, calls, expected) {
  assertQuery(queryObject(new URL(page.url())), expected);
  const request = calls.filter((call) => call.path === auditPath).at(-1);
  assert(request, "An audit read must have occurred.");
  assertQuery(request.query, expected, true);
  await expect(page.locator("#filter-admin")).toHaveValue(expected.admin_user_id || "");
  await expect(page.locator("#filter-target")).toHaveValue(expected.target_id || "");
  await expect(page.locator("#filter-action")).toHaveValue(expected.action || "");
}
async function assertPrivateDataHidden(page) {
  const html = await page.locator("body").evaluate((body) => body.outerHTML);
  assert(!html.includes(secret), "Details and raw server error secrets must never enter the DOM.");
  assert(!html.includes("192.0.2.99"), "Unrequested audit IP addresses must never enter the DOM.");
  await expect(
    page.locator("#audit-tbody img, #audit-tbody script, #audit-tbody [onerror]"),
  ).toHaveCount(0);
  assert.equal(
    await page.evaluate(() => window.__syntheticXss),
    0,
    "Synthetic payloads must not execute.",
  );
}
async function assertResponsive(page) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    "The audit page must not overflow the viewport; the table may scroll inside its wrapper.",
  );
}

async function main() {
  await mkdir(reportDir, { recursive: true });
  let browser;
  let server;
  try {
    report.auditHtmlSha256 = createHash("sha256")
      .update(await readFile(path.join(staticRoot, "security/audit/index.html")))
      .digest("hex");
    const canonicalStaticRoot = await realpath(staticRoot);
    server = createServer(async (req, res) => {
      // No proxies, credentials, real API responses, or writable routes, even if routing fails.
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      if (req.method !== "GET" || pathname.startsWith("/api/")) {
        res.writeHead(405).end("Only static synthetic-fixture reads are permitted");
        return;
      }
      try {
        const relative =
          pathname === "/" || !path.extname(pathname) ? `${pathname}/index.html` : pathname;
        const filename = await realpath(
          path.resolve(staticRoot, `.${decodeURIComponent(relative)}`),
        );
        if (!filename.startsWith(`${canonicalStaticRoot}${path.sep}`)) {
          res.writeHead(400).end();
          return;
        }
        const bytes = await readFile(filename);
        const contentType = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".woff2": "font/woff2",
          ".ico": "image/x-icon",
          ".png": "image/png",
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
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      // Block speculative external DNS/preconnect as well as HTTP routing below.
      args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
      ...(process.env.AUDIT_LOGS_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.AUDIT_LOGS_CHROMIUM_EXECUTABLE }
        : {}),
    });
    report.browser = await browser.version();
    report.browserExecutableOverride = process.env.AUDIT_LOGS_CHROMIUM_EXECUTABLE || null;

    async function scenario(name, viewport, respond, check, options = {}) {
      const colorScheme = options.colorScheme || "light";
      const timezoneId = options.timezoneId || "Asia/Tokyo";
      const context = await browser.newContext({
        viewport,
        colorScheme,
        timezoneId,
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      const page = await context.newPage();
      const calls = [],
        pageErrors = [],
        forbiddenWrites = [],
        unexpectedReads = [],
        fixtureErrors = [],
        requestFailures = [],
        consoleMessages = [];
      const blockedOrigins = new Set();
      await context.routeWebSocket("**/*", (socket) => {
        unexpectedReads.push(`WebSocket ${socket.url()}`);
        socket.close();
      });
      page.on("pageerror", (err) => pageErrors.push(err.message));
      page.on("console", (message) =>
        consoleMessages.push({ type: message.type(), text: message.text() }),
      );
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).pathname === auditPath)
          requestFailures.push({ url: request.url(), error: request.failure()?.errorText });
      });
      await context.addInitScript(({ ignoreFirstAbort, delayFirstJson }) => {
        window.__syntheticXss = 0;
        window.__syntheticAborts = [];
        window.__syntheticJsonStarted = false;
        window.__syntheticJsonResolved = false;
        const nativeFetch = window.fetch.bind(window);
        let firstAuditRead = true;
        window.fetch = (input, init) => {
          const requestUrl =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const isAuditRead =
            new URL(requestUrl, window.location.href).pathname === "/api/audit-logs";
          const first = isAuditRead && firstAuditRead;
          if (isAuditRead) {
            init?.signal?.addEventListener(
              "abort",
              () => window.__syntheticAborts.push(requestUrl),
              { once: true },
            );
            firstAuditRead = false;
          }
          // A transport ignoring cancellation makes both request-sequence guards observable.
          const fetched = nativeFetch(
            input,
            ignoreFirstAbort && first ? { ...init, signal: undefined } : init,
          );
          if (delayFirstJson && first) {
            return fetched.then((response) => {
              const nativeJson = response.json.bind(response);
              response.json = async () => {
                window.__syntheticJsonStarted = true;
                await new Promise((resolve) => {
                  window.__syntheticReleaseJson = resolve;
                });
                const body = await nativeJson();
                window.__syntheticJsonResolved = true;
                return body;
              };
              return response;
            });
          }
          return fetched;
        };
      }, options);
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin !== origin) {
          blockedOrigins.add(url.origin);
          // The shared layout's public font stylesheet is expected but still blocked.
          // Any other external request or synthetic private-value transmission is a failure.
          if (
            url.origin !== "https://fonts.googleapis.com" ||
            url.pathname !== "/css2" ||
            request.url().includes(secret)
          ) {
            unexpectedReads.push(`External ${url.origin}${url.pathname}`);
          }
          await route.abort();
          return;
        }
        if (request.method() !== "GET") {
          forbiddenWrites.push({ method: request.method(), path: url.pathname });
          await route.abort();
          return;
        }
        if (url.pathname === auditPath) {
          try {
            const call = { method: request.method(), path: url.pathname, query: queryObject(url) };
            calls.push(call);
            await respond(route, url, readCount(calls));
          } catch (err) {
            fixtureErrors.push(err instanceof Error ? err.stack : String(err));
            await route.abort().catch(() => {});
          }
          return;
        }
        // Only built page/assets may escape interception, never another API/auth/write flow.
        if (
          url.pathname === "/" ||
          /^\/security\/audit\/?$/.test(url.pathname) ||
          url.pathname.startsWith("/_astro/") ||
          /^\/favicon\.(svg|ico)$/.test(url.pathname)
        ) {
          await route.continue();
          return;
        }
        unexpectedReads.push(url.pathname);
        await route.abort();
      });
      const caseReport = {
        name,
        viewport,
        colorScheme,
        timezoneId,
        calls,
        pageErrors,
        forbiddenWrites,
        unexpectedReads,
        fixtureErrors,
        requestFailures,
        consoleMessages,
        status: "running",
      };
      report.cases.push(caseReport);
      try {
        await check(page, calls, origin);
        assert.deepEqual(forbiddenWrites, [], "No writable requests may occur.");
        assert.deepEqual(
          unexpectedReads,
          [],
          "Only exact synthetic audit reads and compiled static files may occur.",
        );
        assert.deepEqual(fixtureErrors, [], "Synthetic API requests must obey their contract.");
        assert.deepEqual(pageErrors, [], "No uncaught page errors may occur.");
        assert(
          !JSON.stringify(consoleMessages).includes(secret),
          "Raw details/error secrets must not be logged.",
        );
        await assertPrivateDataHidden(page);
        caseReport.status = "passed";
        console.log(`PASS ${viewport.width}px/${colorScheme}: ${name}`);
      } catch (err) {
        caseReport.status = "failed";
        caseReport.error = err instanceof Error ? err.stack : String(err);
        await page
          .screenshot({
            path: path.join(
              reportDir,
              `failed-${report.cases.length}-${viewport.width}-${colorScheme}.png`,
            ),
            fullPage: true,
          })
          .catch(() => {});
        throw err;
      } finally {
        caseReport.blockedOrigins = [...blockedOrigins];
        await context.close();
      }
    }
    const defaultResponse = (route, url) => route.fulfill({ json: filteredResponse(url) });

    for (const viewport of viewports) {
      for (const colorScheme of ["light", "dark"]) {
        await scenario(
          "AND filters, tied-time 51-row count/paging, history/reload, keyboard and responsive layout",
          viewport,
          defaultResponse,
          async (page, calls, origin) => {
            await page.goto(`${origin}/security/audit`);
            await loaded(page, 50);
            await assertState(page, calls, {});
            for (const id of ["filter-admin", "filter-target", "filter-action"]) {
              assert(
                await page.locator(`#${id}`).evaluate((control) => control.labels?.length > 0),
                `${id} needs an accessible label.`,
              );
            }
            await expect(page.locator("#audit-summary")).toHaveAttribute("aria-live", "polite");
            await expect(page.locator("#table-wrap table caption")).toHaveCount(1);
            await page.locator("#filter-admin").focus();
            await page.keyboard.press("Tab");
            await expect(page.locator("#filter-target")).toBeFocused();
            await page.keyboard.press("Tab");
            await expect(page.locator("#filter-action")).toBeFocused();
            await page.keyboard.press("Tab");
            await expect(applyButton(page)).toBeFocused();
            await page.keyboard.press("Tab");
            await expect(page.locator("#reset-filters")).toBeFocused();
            const beforeDraft = readCount(calls);
            await fillFilters(page, matchingFilters);
            await page.waitForTimeout(80);
            assert.equal(readCount(calls), beforeDraft, "Draft edits must not trigger API reads.");
            await page.locator("#filter-admin").press("Enter");
            await loaded(page, 50);
            await assertState(page, calls, matchingFilters);
            await expect(page.locator("#audit-summary")).toContainText("51");
            await expect(page.locator("#pagination")).toBeVisible();
            await expect(page.locator("#prev-btn")).toBeDisabled();
            await expect(page.locator("#next-btn")).toBeEnabled();
            for (const row of await page.locator("#audit-tbody tr").all()) {
              await expect(row.locator("td").nth(1)).toContainText(matchingFilters.admin_user_id);
              await expect(row.locator("td").nth(2)).toHaveText(matchingFilters.action);
              await expect(row.locator("td").nth(3)).toContainText(matchingFilters.target_id);
            }
            const firstUrl = page.url();
            const lastFirstPage = await page
              .locator("#audit-tbody tr")
              .last()
              .locator("td")
              .allTextContents();
            await page.locator("#next-btn").press("Enter");
            await loaded(page, 1);
            await assertState(page, calls, { ...matchingFilters, offset: 50 });
            const lastPage = await page.locator("#audit-tbody tr").locator("td").allTextContents();
            assert.equal(
              lastPage[0],
              lastFirstPage[0],
              "Equal-time rows must survive the page boundary.",
            );
            assert.notEqual(
              lastPage[4],
              lastFirstPage[4],
              "The second page must contain the distinct tied-time fixture row.",
            );
            await expect(page.locator("#audit-summary")).toContainText("51");
            await expect(page.locator("#prev-btn")).toBeEnabled();
            await expect(page.locator("#next-btn")).toBeDisabled();
            const lastUrl = page.url();
            assert.notEqual(lastUrl, firstUrl, "Paging must be represented in browser history.");
            await page.reload();
            await loaded(page, 1);
            await assertState(page, calls, { ...matchingFilters, offset: 50 });
            await page.goBack();
            await loaded(page, 50);
            await expect(page).toHaveURL(firstUrl);
            await assertState(page, calls, matchingFilters);
            await page.goForward();
            await loaded(page, 1);
            await expect(page).toHaveURL(lastUrl);
            await assertState(page, calls, { ...matchingFilters, offset: 50 });
            await fillFilters(page, { ...matchingFilters, target_id: noMatchTarget });
            await applyButton(page).press("Space");
            await loaded(page, 0);
            await assertState(page, calls, { ...matchingFilters, target_id: noMatchTarget });
            await expect(page.locator("#empty-message")).toBeVisible();
            await expect(page.locator("#audit-summary")).toContainText("0");
            await expect(page.locator("#prev-btn")).toBeDisabled();
            await expect(page.locator("#next-btn")).toBeDisabled();
            await assertResponsive(page);
            await page.screenshot({
              path: path.join(reportDir, `empty-${viewport.width}-${colorScheme}.png`),
              fullPage: true,
            });
            await page.locator("#reset-filters").press("Space");
            await loaded(page, 50);
            await assertState(page, calls, {});
            await expect(page.locator("#empty-message")).toBeHidden();
            await page.goBack();
            await loaded(page, 0);
            await assertState(page, calls, { ...matchingFilters, target_id: noMatchTarget });
            await page.goForward();
            await loaded(page, 50);
            await assertState(page, calls, {});
            await assertPrivateDataHidden(page);
            await assertResponsive(page);
            await page.screenshot({
              path: path.join(reportDir, `audit-${viewport.width}-${colorScheme}.png`),
              fullPage: true,
            });
          },
          { colorScheme },
        );

        const retryGate = deferred();
        await scenario(
          "Static safe errors, keyboard retry, loading guard and retained filters",
          viewport,
          async (route, url, n) => {
            if (n === 1)
              await route.fulfill({
                status: 503,
                json: { error: { code: "INTERNAL_ERROR", message: rawError }, details: secret },
              });
            else if (n === 2) {
              await retryGate.promise;
              await route.fulfill({ status: 500, json: { error: { message: rawError } } });
            } else await defaultResponse(route, url);
          },
          async (page, calls, origin) => {
            try {
              const query = new URLSearchParams({ ...matchingFilters, offset: "50" });
              await page.goto(`${origin}/security/audit?${query}`);
              await expect(page.locator("#error-message")).toBeVisible();
              await expect(page.locator("#error-message")).not.toContainText(secret);
              await expect(page.locator("#error-message")).not.toContainText(malicious);
              await expect(page.locator("#table-wrap")).toBeHidden();
              await expect(page.locator("#retry-btn")).toBeEnabled();
              await expect(page.locator("#error")).toHaveAttribute("role", "alert");
              await assertState(page, calls, { ...matchingFilters, offset: 50 });
              await assertPrivateDataHidden(page);
              await assertResponsive(page);
              await page.screenshot({
                path: path.join(reportDir, `error-${viewport.width}-${colorScheme}.png`),
                fullPage: true,
              });
              await page.locator("#retry-btn").press("Enter");
              await expect(page.locator("#loading")).toBeVisible();
              await expect(page.locator("#retry-btn")).toBeDisabled();
              await page.evaluate(() => {
                const button = document.getElementById("retry-btn");
                button.dispatchEvent(new MouseEvent("click"));
                button.dispatchEvent(new MouseEvent("click"));
              });
              await page.waitForTimeout(80);
              assert.equal(
                readCount(calls),
                2,
                "An in-flight retry must not issue duplicate reads.",
              );
              retryGate.resolve();
              await expect(page.locator("#loading")).toBeHidden();
              await expect(page.locator("#error-message")).toBeVisible();
              await expect(page.locator("#retry-btn")).toBeEnabled();
              await page.locator("#retry-btn").press("Space");
              await loaded(page, 1);
              await assertState(page, calls, { ...matchingFilters, offset: 50 });
              assert.equal(readCount(calls), 3);
            } finally {
              retryGate.resolve();
            }
          },
          { colorScheme },
        );
      }
    }

    await scenario(
      "Each filter is exact and AND excludes rows matching only two conditions",
      viewports[1],
      defaultResponse,
      async (page, calls, origin) => {
        for (const filters of [
          { admin_user_id: otherAdmin },
          { target_id: otherTarget },
          { action: "user.unban" },
          { admin_user_id: otherAdmin, target_id: otherTarget },
          {
            admin_user_id: matchingFilters.admin_user_id,
            target_id: otherTarget,
            action: "user.ban",
          },
          { ...matchingFilters, action: "service.delete" },
          { action: "custom.new_action" },
        ]) {
          const expectedCount = logs.filter((row) =>
            filterNames.every((key) => !filters[key] || row[key] === filters[key]),
          ).length;
          await page.goto(`${origin}/security/audit?${new URLSearchParams(filters)}`);
          await loaded(page, expectedCount);
          await assertState(page, calls, filters);
          await expect(page.locator("#audit-summary")).toContainText(String(expectedCount));
          if (!expectedCount) await expect(page.locator("#empty-message")).toBeVisible();
        }
      },
    );

    await scenario(
      "Invalid UUID/action/URL filters never silently broaden a read; reset recovers",
      viewports[1],
      defaultResponse,
      async (page, calls, origin) => {
        const invalidQueries = [
          "admin_user_id=not-a-uuid",
          "target_id=not-a-uuid",
          "admin_user_id=",
          "target_id=",
          "action=",
          "action=USER.BAN",
          "action=user",
          "action=user.ban.extra",
          "action=user.ban1",
          "action=user.%3Cscript%3E",
          `admin_user_id=${matchingFilters.admin_user_id}&admin_user_id=${otherAdmin}`,
          "action=user.ban&action=user.delete",
          `target_id=${matchingFilters.target_id}&target_id=${otherTarget}`,
          "admin=ignored",
          "offset=-1",
          "offset=0.5",
          "offset=9007199254740992",
          "limit=100",
          `action=${"a".repeat(2_049)}`,
        ];
        for (const query of invalidQueries) {
          await page.goto(`${origin}/security/audit?${query}`);
          await expect(page.locator("#error-message")).toBeVisible();
          await expect(page.locator("#table-wrap")).toBeHidden();
          await expect(page.locator("#loading")).toBeHidden();
          assert.equal(
            readCount(calls),
            0,
            "Invalid URL filters must never trigger an unfiltered read.",
          );
        }
        await page.locator("#retry-btn").press("Enter");
        await page.waitForTimeout(80);
        assert.equal(readCount(calls), 0);
        await page.locator("#reset-filters").press("Enter");
        await loaded(page, 50);
        await assertState(page, calls, {});
        for (const filters of [
          { admin_user_id: "not-a-uuid" },
          { target_id: "javascript:alert(1)" },
          { action: "USER.BAN" },
          { action: "user.ban.extra" },
        ]) {
          await fillFilters(page, filters);
          const before = readCount(calls);
          await applyButton(page).click();
          await page.waitForTimeout(80);
          assert.equal(readCount(calls), before, "Invalid form filters must not reach the API.");
          // Retry cannot switch an invalid investigation to an edited, valid draft.
          await fillFilters(page, matchingFilters);
          await page.locator("#retry-btn").click();
          await page.waitForTimeout(80);
          assert.equal(
            readCount(calls),
            before,
            "Retry must retain the submitted invalid query until Apply or Reset.",
          );
          await page.locator("#reset-filters").click();
          await loaded(page, 50);
        }
        await fillFilters(page, matchingFilters);
        await applyButton(page).click();
        await loaded(page, 50);
        await assertState(page, calls, matchingFilters);
      },
    );

    await scenario(
      "Out-of-range offsets recover to the last matching page or empty first page",
      viewports[1],
      defaultResponse,
      async (page, calls, origin) => {
        await page.goto(
          `${origin}/security/audit?${new URLSearchParams({ ...matchingFilters, offset: "100" })}`,
        );
        await loaded(page, 1);
        await assertState(page, calls, { ...matchingFilters, offset: 50 });
        assert.deepEqual(
          calls.map((call) => call.query.offset),
          ["100", "50"],
        );
        await page.goto(`${origin}/security/audit?target_id=${noMatchTarget}&offset=50`);
        await loaded(page, 0);
        await assertState(page, calls, { target_id: noMatchTarget });
        assert.deepEqual(
          calls.slice(-2).map((call) => call.query.offset),
          ["50", "0"],
        );
        await expect(page.locator("#empty-message")).toBeVisible();
      },
    );

    const applyGate = deferred();
    await scenario(
      "Repeated Apply is guarded without duplicate history; changed query resets offset",
      viewports[1],
      async (route, url, n) => {
        if (n === 2) await applyGate.promise;
        await defaultResponse(route, url);
      },
      async (page, calls, origin) => {
        try {
          await page.goto(
            `${origin}/security/audit?${new URLSearchParams({ ...matchingFilters, offset: "50" })}`,
          );
          await loaded(page, 1);
          const initialUrl = page.url();
          const initialHistoryLength = await page.evaluate(() => window.history.length);
          await applyButton(page).click();
          await expect.poll(() => readCount(calls)).toBe(2);
          await expect(page.locator("#loading")).toBeVisible();
          await page.evaluate(() => {
            const form = document.getElementById("filter-form");
            form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
            form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          });
          await page.waitForTimeout(80);
          assert.equal(readCount(calls), 2, "Identical in-flight applies must be guarded.");
          applyGate.resolve();
          await loaded(page, 50);
          await assertState(page, calls, matchingFilters);
          assert.equal(
            await page.evaluate(() => window.history.length),
            initialHistoryLength + 1,
            "Repeated Apply must create one history entry.",
          );
          await page.goBack();
          await loaded(page, 1);
          await expect(page).toHaveURL(initialUrl);
          await assertState(page, calls, { ...matchingFilters, offset: 50 });
          await fillFilters(page, { ...matchingFilters, action: "user.unban" });
          await applyButton(page).click();
          await loaded(page, 1);
          await assertState(page, calls, { ...matchingFilters, action: "user.unban" });
        } finally {
          applyGate.resolve();
        }
      },
    );

    for (const staleStatus of [200, 403, 401]) {
      const staleGate = deferred(),
        delivered = deferred();
      await scenario(
        `Stale ${staleStatus} responses cannot overwrite/redirect a newer query even if cancellation is ignored`,
        viewports[1],
        async (route, url, n) => {
          if (n === 1) {
            await staleGate.promise;
            await route.fulfill({
              status: staleStatus,
              json:
                staleStatus === 200
                  ? {
                      data: [auditLog(1, { action: "synthetic.stale", admin_user_id: otherAdmin })],
                      pagination: { limit: 50, offset: 0, total: 1 },
                    }
                  : {
                      error: {
                        code: staleStatus === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
                        message: rawError,
                      },
                    },
            });
            delivered.resolve();
          } else await defaultResponse(route, url);
        },
        async (page, calls, origin) => {
          try {
            await page.goto(`${origin}/security/audit`, { waitUntil: "domcontentloaded" });
            await expect.poll(() => readCount(calls)).toBe(1);
            await expect(page.locator("#loading")).toBeVisible();
            await fillFilters(page, matchingFilters);
            await applyButton(page).click();
            await loaded(page, 50);
            await assertState(page, calls, matchingFilters);
            assert(
              (await page.evaluate(() => window.__syntheticAborts.length)) >= 1,
              "Superseded reads must cancel their AbortSignal.",
            );
            staleGate.resolve();
            await delivered.promise;
            await page.waitForTimeout(150);
            await loaded(page, 50);
            await assertState(page, calls, matchingFilters);
            await expect(page.locator("#audit-tbody")).not.toContainText("synthetic.stale");
            assert.equal(readCount(calls), 2);
          } finally {
            staleGate.resolve();
          }
        },
        { ignoreFirstAbort: true },
      );
    }

    await scenario(
      "A superseded successful JSON body cannot overwrite the newer query after headers already arrived",
      viewports[1],
      (route, url, n) =>
        n === 1
          ? route.fulfill({
              json: {
                data: [auditLog(1, { action: "synthetic.stale", admin_user_id: otherAdmin })],
                pagination: { total: 1, limit: 50, offset: 0 },
              },
            })
          : defaultResponse(route, url),
      async (page, calls, origin) => {
        try {
          await page.goto(`${origin}/security/audit`, { waitUntil: "domcontentloaded" });
          await expect.poll(() => page.evaluate(() => window.__syntheticJsonStarted)).toBe(true);
          await expect(page.locator("#loading")).toBeVisible();
          await fillFilters(page, matchingFilters);
          await applyButton(page).click();
          await loaded(page, 50);
          await assertState(page, calls, matchingFilters);
          assert((await page.evaluate(() => window.__syntheticAborts.length)) >= 1);
          await page.evaluate(() => window.__syntheticReleaseJson());
          await expect.poll(() => page.evaluate(() => window.__syntheticJsonResolved)).toBe(true);
          await page.waitForTimeout(100);
          await loaded(page, 50);
          await assertState(page, calls, matchingFilters);
          await expect(page.locator("#audit-tbody")).not.toContainText("synthetic.stale");
          assert.equal(readCount(calls), 2);
        } finally {
          await page.evaluate(() => window.__syntheticReleaseJson?.()).catch(() => {});
        }
      },
      { ignoreFirstAbort: true, delayFirstJson: true },
    );

    await scenario(
      "SQLite UTC timestamps and ISO timestamps render identically in Asia/Tokyo",
      viewports[1],
      (route) =>
        route.fulfill({
          json: {
            data: [
              auditLog(1, { created_at: "2026-10-02 01:00:00" }),
              auditLog(2, { created_at: "2026-10-02T01:00:00Z" }),
              auditLog(3, { created_at: "2026-10-02T10:00:00+09:00" }),
            ],
            pagination: { total: 3, limit: 50, offset: 0 },
          },
        }),
      async (page, calls, origin) => {
        await page.goto(`${origin}/security/audit`);
        await loaded(page, 3);
        const dates = await page.locator("#audit-tbody tr td:first-child").allTextContents();
        assert.equal(dates[0], dates[1]);
        assert.equal(dates[0], dates[2]);
        assert.match(dates[0], /2026\/10\/02/);
        assert.match(dates[0], /10:00/);
        assert.equal(readCount(calls), 1);
      },
    );

    await scenario(
      "A network failure retains the query and keyboard retry recovers",
      viewports[0],
      (route, url, n) => (n === 1 ? route.abort("failed") : defaultResponse(route, url)),
      async (page, calls, origin) => {
        await page.goto(`${origin}/security/audit?${new URLSearchParams(matchingFilters)}`);
        await expect(page.locator("#error-message")).toBeVisible();
        await assertState(page, calls, matchingFilters);
        await page.locator("#retry-btn").press("Space");
        await loaded(page, 50);
        await assertState(page, calls, matchingFilters);
        assert.equal(readCount(calls), 2);
      },
    );

    await scenario(
      "401 uses the existing sign-in redirect",
      viewports[1],
      (route) =>
        route.fulfill({
          status: 401,
          json: { error: { code: "UNAUTHORIZED", message: rawError } },
        }),
      async (page, calls, origin) => {
        await page.goto(`${origin}/security/audit?${new URLSearchParams(matchingFilters)}`);
        await expect(page).toHaveURL(`${origin}/`);
        assert.equal(readCount(calls), 1);
      },
    );

    await scenario(
      "403 stays on the audit page with static safe text and no raw details",
      viewports[1],
      (route) =>
        route.fulfill({
          status: 403,
          json: { error: { code: "FORBIDDEN", message: rawError }, details: secret },
        }),
      async (page, calls, origin) => {
        await page.goto(`${origin}/security/audit?${new URLSearchParams(matchingFilters)}`);
        await expect(page.locator("#error-message")).toBeVisible();
        assert((await page.locator("#error-message").textContent()).trim().length > 0);
        await expect(page.locator("#error-message")).not.toContainText(rawError);
        await expect(page.locator("#error-message")).not.toContainText(secret);
        await expect(page.locator("#table-wrap")).toBeHidden();
        await expect(page.locator("#loading")).toBeHidden();
        await assertState(page, calls, matchingFilters);
        assert.equal(readCount(calls), 1);
      },
    );

    await scenario(
      "Malformed success data produces a safe error and retry can recover",
      viewports[1],
      (route, url, n) =>
        n === 1
          ? route.fulfill({
              json: {
                data: secret,
                pagination: { total: 1, limit: 50, offset: 0 },
                details: secret,
              },
            })
          : defaultResponse(route, url),
      async (page, calls, origin) => {
        await page.goto(`${origin}/security/audit?${new URLSearchParams(matchingFilters)}`);
        await expect(page.locator("#error-message")).toBeVisible();
        await expect(page.locator("#table-wrap")).toBeHidden();
        await expect(page.locator("#audit-tbody tr")).toHaveCount(0);
        await page.locator("#retry-btn").click();
        await loaded(page, 50);
        await assertState(page, calls, matchingFilters);
      },
    );

    for (const field of filterNames) {
      await scenario(
        `An API response violating the applied ${field} cannot broaden the investigation`,
        viewports[1],
        (route, url, n) => {
          const response = filteredResponse(url);
          if (n === 1)
            response.data = [
              { ...response.data[0], [field]: field === "action" ? "user.delete" : otherAdmin },
              ...response.data.slice(1),
            ];
          return route.fulfill({ json: response });
        },
        async (page, calls, origin) => {
          await page.goto(`${origin}/security/audit?${new URLSearchParams(matchingFilters)}`);
          await expect(page.locator("#error-message")).toBeVisible();
          await expect(page.locator("#table-wrap")).toBeHidden();
          await expect(page.locator("#audit-tbody tr")).toHaveCount(0);
          await assertState(page, calls, matchingFilters);
          await page.locator("#retry-btn").press("Enter");
          await loaded(page, 50);
          await assertState(page, calls, matchingFilters);
          assert.equal(readCount(calls), 2);
        },
      );
    }

    for (const { name, mutate } of [
      {
        name: "missing pagination",
        mutate: (response) => {
          delete response.pagination;
        },
      },
      {
        name: "unbounded limit",
        mutate: (response) => {
          response.pagination.limit = 100;
        },
      },
      {
        name: "wrong offset",
        mutate: (response) => {
          response.pagination.offset = 50;
        },
      },
      {
        name: "inconsistent count",
        mutate: (response) => {
          response.pagination.total = 49;
        },
      },
      {
        name: "more than 50 rows",
        mutate: (response) => {
          response.data.push(auditLog(51));
        },
      },
      {
        name: "invalid row",
        mutate: (response) => {
          response.data[0] = null;
        },
      },
    ]) {
      await scenario(
        `Malformed ${name} fails closed without retaining a previous result`,
        viewports[1],
        (route, url, n) => {
          const response = filteredResponse(url);
          if (n === 2) mutate(response);
          return route.fulfill({ json: response });
        },
        async (page, calls, origin) => {
          await page.goto(`${origin}/security/audit?${new URLSearchParams(matchingFilters)}`);
          await loaded(page, 50);
          await applyButton(page).click();
          await expect(page.locator("#error-message")).toBeVisible();
          await expect(page.locator("#table-wrap")).toBeHidden();
          await expect(page.locator("#audit-tbody tr")).toHaveCount(0);
          await assertState(page, calls, matchingFilters);
          await page.locator("#retry-btn").click();
          await loaded(page, 50);
          await assertState(page, calls, matchingFilters);
          assert.equal(readCount(calls), 3);
        },
      );
    }

    await scenario(
      "Untrusted fields fail closed; only known-type UUID links are local; deleted targets need no lookup",
      viewports[0],
      (route) =>
        route.fulfill({
          json: {
            data: [
              auditLog(1, {
                created_at: malicious,
                admin_user_id: malicious,
                action: malicious,
                target_type: malicious,
                target_id: malicious,
                status: malicious,
              }),
              auditLog(2, { target_type: "user", target_id: deletedTarget, action: "user.delete" }),
              auditLog(3, {
                target_type: "service",
                target_id: otherTarget,
                action: "service.delete",
              }),
              auditLog(4, { target_type: "unknown", target_id: otherTarget }),
              auditLog(5, { target_type: "user", target_id: "javascript:alert(1)" }),
              auditLog(6, { target_type: "service", target_id: "//outside.invalid/target" }),
              auditLog(7, {
                admin_user_id: "ABCDEFAB-1234-4123-8123-ABCDEFABCDEF",
                target_id: "ABCDEFAB-5678-4567-8567-ABCDEFABCDEF",
              }),
            ],
            pagination: { total: 7, limit: 50, offset: 0 },
          },
        }),
      async (page, calls, origin) => {
        await page.goto(`${origin}/security/audit`);
        await loaded(page, 7);
        const rows = page.locator("#audit-tbody tr");
        const cells = rows.nth(0).locator("td");
        await expect(cells.nth(0)).toHaveText("日時不明");
        await expect(cells.nth(1)).toHaveText("ID形式不明");
        await expect(cells.nth(2)).toHaveText("不明な操作");
        await expect(cells.nth(3)).toContainText("その他");
        await expect(cells.nth(3)).toContainText("ID形式不明");
        await expect(cells.nth(4)).toHaveText("不明");
        await expect(rows.nth(0).locator("a")).toHaveCount(0);
        await expect(rows.nth(1).locator(`a[href="/users/${deletedTarget}"]`)).toHaveCount(1);
        await expect(rows.nth(2).locator(`a[href="/services/${otherTarget}"]`)).toHaveCount(1);
        for (const i of [3, 4, 5])
          await expect(rows.nth(i).locator("td").nth(3).locator("a")).toHaveCount(0);
        await expect(
          rows.nth(6).locator('a[href="/users/abcdefab-1234-4123-8123-abcdefabcdef"]'),
        ).toHaveText("ABCDEFAB-1234-4123-8123-ABCDEFABCDEF");
        await expect(
          rows.nth(6).locator('a[href="/users/abcdefab-5678-4567-8567-abcdefabcdef"]'),
        ).toHaveText("ABCDEFAB-5678-4567-8567-ABCDEFABCDEF");
        for (const anchor of await page.locator("#audit-tbody a").all()) {
          const href = await anchor.getAttribute("href");
          assert.match(href, /^\/(users|services)\/[0-9a-f-]{36}$/i);
          assert.equal(new URL(href, origin).origin, origin);
        }
        assert.equal(
          readCount(calls),
          1,
          "Persisted deleted-target IDs must render without any user/service lookup.",
        );
        await assertPrivateDataHidden(page);
        await assertResponsive(page);
        await page.screenshot({
          path: path.join(reportDir, "safe-links-320-light.png"),
          fullPage: true,
        });
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
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
  }
  console.log(`Audit logs UI: ${report.cases.length} synthetic browser cases passed`);
}

await main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
