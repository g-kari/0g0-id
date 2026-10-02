/* global document, window, MouseEvent */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const playwrightModule = process.env.SECURITY_EVENTS_PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  throw new Error(
    "Set SECURITY_EVENTS_PLAYWRIGHT_MODULE to the disposable @playwright/test install.",
  );
}
const require = createRequire(import.meta.url);
const { chromium, expect } = require(playwrightModule);
const playwrightVersion = require(path.join(playwrightModule, "package.json")).version;
assert.equal(playwrightVersion, "1.57.0", "Use the CI-pinned browser test toolchain.");
const staticRoot = path.resolve("workers/admin/dist/client");
const reportDir = path.resolve(process.env.SECURITY_EVENTS_REPORT_DIR || "security-events-ui");
const eventsPath = "/api/security-trends/recent-events";
const viewports = [
  { width: 320, height: 740 },
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
];
const fixtureNow = Date.parse("2026-10-02T12:00:00Z");
const malicious = '<img src="/synthetic-xss" onerror="window.__syntheticXss=1">';
const matchingFilters = { user_id: "synthetic-match", country: "JP", provider: "google" };
function event(id, overrides = {}) {
  return {
    id: `synthetic-event-${id}`,
    user_id: matchingFilters.user_id,
    provider: "google",
    ip_address: "192.0.2.10",
    user_agent: "Synthetic browser fixture",
    country: "JP",
    created_at: new Date(fixtureNow - id * 60_000).toISOString(),
    ...overrides,
  };
}
const events = [
  ...Array.from({ length: 51 }, (_, i) => event(i + 1)),
  event(52, { user_id: "synthetic-other" }),
  event(53, { country: "US" }),
  ...["github", "line", "twitch", "x"].map((provider, i) => event(54 + i, { provider })),
  event(58, { user_id: "synthetic-unknown", country: null }),
  event(59, { user_id: "synthetic-unknown", country: "" }),
  event(60, { user_id: "synthetic-unknown", country: "JP" }),
];
const report = {
  sourceCommit: process.env.GITHUB_SHA || null,
  runId: process.env.GITHUB_RUN_ID || null,
  node: process.version,
  playwright: playwrightVersion,
  scope:
    "Actual built admin events/dashboard UI; synthetic GET responses only; exact-origin network guard",
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
  const filters = url.searchParams;
  assert.equal(filters.get("limit"), "50", "The browser must use bounded 50-row reads.");
  const offset = Number(filters.get("offset") || "0");
  assert(Number.isInteger(offset) && offset >= 0);
  const period = filters.get("period") || "all";
  const windowMs = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000, all: Infinity }[
    period
  ];
  assert.notEqual(windowMs, undefined, "The browser must send a supported period.");
  const selected = events.filter((row) => {
    if (filters.get("user_id") && row.user_id !== filters.get("user_id")) return false;
    if (filters.get("provider") && row.provider !== filters.get("provider")) return false;
    const country = filters.get("country");
    if (country === "unknown" && row.country !== null) return false;
    if (country && country !== "unknown" && row.country !== country) return false;
    return Date.parse(row.created_at) >= fixtureNow - windowMs;
  });
  return {
    data: selected.slice(offset, offset + 50),
    meta: {
      limit: 50,
      offset,
      total: selected.length,
      ...([...filters.keys()].some((key) =>
        ["user_id", "country", "provider", "period"].includes(key),
      )
        ? {
            applied_filters: {
              user_id: filters.get("user_id"),
              country: filters.get("country"),
              provider: filters.get("provider"),
              period,
            },
          }
        : {}),
    },
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
  const allowed = new Set([
    "user_id",
    "country",
    "provider",
    "period",
    "offset",
    ...(api ? ["limit"] : []),
  ]);
  for (const name of Object.keys(actual))
    assert(allowed.has(name), `Unexpected query parameter: ${name}`);
  for (const name of ["user_id", "country", "provider"]) {
    assert.equal(
      actual[name] || "",
      expected[name] || "",
      `${name} must match the applied filter.`,
    );
  }
  assert.equal(
    actual.period || "all",
    expected.period || "all",
    "The period must survive navigation.",
  );
  assert.equal(
    actual.offset || "0",
    String(expected.offset || 0),
    "The filtered offset must be preserved.",
  );
  if (!expected.period || expected.period === "all") {
    assert.equal(
      actual.period,
      undefined,
      "All/default must be omitted from canonical URLs and API reads.",
    );
  }
  if (api) assert.equal(actual.limit, "50");
}
async function fillFilters(page, filters) {
  await page.locator("#filter-user").fill(filters.user_id || "");
  await page.locator("#filter-country").fill(filters.country || "");
  await page.locator("#filter-provider").selectOption(filters.provider || "");
  await page.locator("#filter-period").selectOption(filters.period || "all");
}
async function loaded(page, count) {
  await expect(page.locator("#table-wrap")).toBeVisible();
  await expect(page.locator("#loading")).toBeHidden();
  await expect(page.locator("#events-tbody tr")).toHaveCount(count);
}
async function assertState(page, calls, expected) {
  assertQuery(queryObject(new URL(page.url())), expected);
  const request = calls.filter((call) => call.path === eventsPath).at(-1);
  assert(request, "An events read must have occurred.");
  assertQuery(request.query, expected, true);
  await expect(page.locator("#filter-user")).toHaveValue(expected.user_id || "");
  await expect(page.locator("#filter-country")).toHaveValue(expected.country || "");
  await expect(page.locator("#filter-provider")).toHaveValue(expected.provider || "");
  await expect(page.locator("#filter-period")).toHaveValue(expected.period || "all");
}

async function main() {
  await mkdir(reportDir, { recursive: true });
  for (const name of ["events", "dashboard"]) {
    report[`${name}HtmlSha256`] = createHash("sha256")
      .update(await readFile(path.join(staticRoot, `security/${name}/index.html`)))
      .digest("hex");
  }
  const server = createServer(async (req, res) => {
    // No proxies, credentials, production data, writable routes, or real API responses.
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (req.method !== "GET" || pathname.startsWith("/api/")) {
      res.writeHead(405).end("Only static synthetic-fixture reads are permitted");
      return;
    }
    let filename;
    try {
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
      ...(process.env.SECURITY_EVENTS_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.SECURITY_EVENTS_CHROMIUM_EXECUTABLE }
        : {}),
    });
    report.browser = await browser.version();
    report.browserExecutableOverride = process.env.SECURITY_EVENTS_CHROMIUM_EXECUTABLE || null;

    async function scenario(name, viewport, respond, check, options = {}) {
      const context = await browser.newContext({ viewport, serviceWorkers: "block" });
      const page = await context.newPage();
      const calls = [];
      const pageErrors = [];
      const forbiddenWrites = [];
      const unexpectedReads = [];
      const blockedOrigins = new Set();
      const requestFailures = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).pathname === eventsPath) {
          requestFailures.push({ url: request.url(), error: request.failure()?.errorText });
        }
      });
      await context.addInitScript(({ ignoreFirstAbort }) => {
        window.__syntheticXss = 0;
        window.__syntheticAborts = [];
        const nativeFetch = window.fetch.bind(window);
        let firstEventsRead = true;
        window.fetch = (input, init) => {
          const requestUrl =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          init?.signal?.addEventListener("abort", () => window.__syntheticAborts.push(requestUrl), {
            once: true,
          });
          if (
            ignoreFirstAbort &&
            firstEventsRead &&
            requestUrl.startsWith("/api/security-trends/recent-events?")
          ) {
            firstEventsRead = false;
            // Simulate a response that completes despite cancellation to verify the sequence guard.
            return nativeFetch(input, { ...init, signal: undefined });
          }
          return nativeFetch(input, init);
        };
      }, options);
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
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
          const call = { method: request.method(), path: url.pathname, query: queryObject(url) };
          calls.push(call);
          if (url.pathname === eventsPath) {
            await respond(route, url, calls.filter((entry) => entry.path === eventsPath).length);
          } else if (url.pathname === "/api/metrics/suspicious-logins") {
            await route.fulfill({
              json: {
                data: [
                  { user_id: matchingFilters.user_id, country_count: 2, countries: "JP,US" },
                  { user_id: malicious, country_count: 2, countries: malicious },
                ],
              },
            });
          } else if (
            [
              "/api/metrics/login-trends",
              "/api/security-trends/ip-stats",
              "/api/security-trends/user-agent-stats",
            ].includes(url.pathname)
          ) {
            await route.fulfill({ json: { data: [] } });
          } else {
            unexpectedReads.push(url.pathname);
            await route.abort();
          }
          return;
        }
        if (url.pathname === "/synthetic-xss") unexpectedReads.push(url.pathname);
        await route.continue();
      });
      const caseReport = {
        name,
        viewport,
        calls,
        pageErrors,
        forbiddenWrites,
        unexpectedReads,
        requestFailures,
        status: "running",
      };
      report.cases.push(caseReport);
      try {
        await check(page, calls, origin);
        assert.deepEqual(forbiddenWrites, [], "No writable requests may occur.");
        assert.deepEqual(unexpectedReads, [], "Only exact synthetic API routes may occur.");
        assert.deepEqual(pageErrors, [], "No uncaught page errors may occur.");
        assert.equal(
          await page.evaluate(() => window.__syntheticXss),
          0,
          "Synthetic payloads must not execute.",
        );
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
    const defaultResponse = (route, url) => route.fulfill({ json: filteredResponse(url) });

    for (const viewport of viewports) {
      await scenario(
        "Combined filters, all periods/providers, 51-row paging, keyboard apply/reset and responsive layout",
        viewport,
        defaultResponse,
        async (page, calls, origin) => {
          await page.goto(`${origin}/security/events`);
          await loaded(page, 50);
          await assertState(page, calls, {});
          for (const id of ["filter-user", "filter-country", "filter-provider", "filter-period"]) {
            assert(
              await page.locator(`#${id}`).evaluate((control) => control.labels?.length > 0),
              `${id} needs an accessible label.`,
            );
          }
          await page.locator("#filter-user").focus();
          for (const id of [
            "filter-country",
            "filter-provider",
            "filter-period",
            "apply-filters",
            "reset-filters",
          ]) {
            await page.keyboard.press("Tab");
            await expect(page.locator(`#${id}`)).toBeFocused();
          }
          const originalReads = calls.filter((call) => call.path === eventsPath).length;
          await fillFilters(page, { ...matchingFilters, period: "24h" });
          await page.waitForTimeout(80);
          assert.equal(
            calls.filter((call) => call.path === eventsPath).length,
            originalReads,
            "Draft filter edits must not make reads.",
          );
          await page.locator("#filter-user").press("Enter");
          await loaded(page, 50);
          await assertState(page, calls, { ...matchingFilters, period: "24h" });
          await expect(page.locator("#events-summary")).toContainText("51");
          await expect(page.locator("#prev-btn")).toBeDisabled();
          await expect(page.locator("#next-btn")).toBeEnabled();
          await page.locator("#next-btn").press("Enter");
          await loaded(page, 1);
          await assertState(page, calls, { ...matchingFilters, period: "24h", offset: 50 });
          await expect(page.locator("#events-tbody")).toContainText("synthetic-match");
          await expect(page.locator("#next-btn")).toBeDisabled();
          await expect(page.locator("#prev-btn")).toBeEnabled();
          await expect(page.locator("#events-summary")).toContainText("51 - 51");
          await page.locator("#prev-btn").press("Space");
          await loaded(page, 50);
          await assertState(page, calls, { ...matchingFilters, period: "24h" });
          await page.locator("#next-btn").click();
          await loaded(page, 1);
          for (const period of ["7d", "30d", "all"]) {
            await page.locator("#filter-period").selectOption(period);
            await page.locator("#apply-filters").click();
            await loaded(page, 50);
            await assertState(page, calls, { ...matchingFilters, period });
            await expect(page.locator("#prev-btn")).toBeDisabled();
          }
          for (const provider of ["github", "line", "twitch", "x"]) {
            await page.locator("#filter-provider").selectOption(provider);
            await page.locator("#apply-filters").click();
            await loaded(page, 1);
            await assertState(page, calls, { ...matchingFilters, provider });
            await expect(page.locator("#events-tbody td").nth(2)).toHaveText(provider);
          }
          await page.locator("#reset-filters").press("Space");
          await loaded(page, 50);
          await assertState(page, calls, {});
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            true,
            "The filter page must not overflow the viewport.",
          );
          await page.screenshot({
            path: path.join(reportDir, `filters-${viewport.width}.png`),
            fullPage: true,
          });
        },
      );

      await scenario(
        "Reload/back/forward preserve applied filters and filtered pagination",
        viewport,
        defaultResponse,
        async (page, calls, origin) => {
          await page.goto(`${origin}/security/events`);
          await loaded(page, 50);
          await fillFilters(page, { ...matchingFilters, period: "7d" });
          await page.locator("#apply-filters").click();
          await loaded(page, 50);
          const firstUrl = page.url();
          await page.locator("#next-btn").click();
          await loaded(page, 1);
          const nextUrl = page.url();
          assert.notEqual(nextUrl, firstUrl, "Paging must be represented in history.");
          await page.reload();
          await loaded(page, 1);
          await assertState(page, calls, { ...matchingFilters, period: "7d", offset: 50 });
          await page.goBack();
          await loaded(page, 50);
          await expect(page).toHaveURL(firstUrl);
          await assertState(page, calls, { ...matchingFilters, period: "7d" });
          await page.goForward();
          await loaded(page, 1);
          await expect(page).toHaveURL(nextUrl);
          await assertState(page, calls, { ...matchingFilters, period: "7d", offset: 50 });
          await page.locator("#reset-filters").click();
          await loaded(page, 50);
          await assertState(page, calls, {});
          await page.goBack();
          await loaded(page, 1);
          await expect(page).toHaveURL(nextUrl);
          await assertState(page, calls, { ...matchingFilters, period: "7d", offset: 50 });
          await page.goForward();
          await loaded(page, 50);
          await assertState(page, calls, {});
        },
      );

      await scenario(
        "Unknown-country and empty results retain filter context",
        viewport,
        defaultResponse,
        async (page, calls, origin) => {
          await page.goto(
            `${origin}/security/events?user_id=synthetic-unknown&country=unknown&provider=google&period=30d`,
          );
          await loaded(page, 1);
          await assertState(page, calls, {
            user_id: "synthetic-unknown",
            country: "unknown",
            provider: "google",
            period: "30d",
          });
          await expect(page.locator("#empty-message")).toBeHidden();
          await page.locator("#filter-user").fill("synthetic-no-matches");
          await page.locator("#apply-filters").click();
          await loaded(page, 0);
          await assertState(page, calls, {
            user_id: "synthetic-no-matches",
            country: "unknown",
            provider: "google",
            period: "30d",
          });
          await expect(page.locator("#empty-message")).toBeVisible();
          await expect(page.locator("#events-summary")).toContainText("0");
          await expect(page.locator("#prev-btn")).toBeDisabled();
          await expect(page.locator("#next-btn")).toBeDisabled();
          await page.screenshot({
            path: path.join(reportDir, `empty-${viewport.width}.png`),
            fullPage: true,
          });
        },
      );

      const retryGate = deferred();
      await scenario(
        "Escaped HTTP error, keyboard retry, guarded retry and filter preservation",
        viewport,
        async (route, url, n) => {
          if (n === 1)
            await route.fulfill({ status: 503, json: { error: { message: malicious } } });
          else if (n === 2) {
            await retryGate.promise;
            await route.fulfill({
              status: 500,
              json: { error: { message: "Synthetic retry failure" } },
            });
          } else await defaultResponse(route, url);
        },
        async (page, calls, origin) => {
          try {
            await page.goto(
              `${origin}/security/events?user_id=synthetic-match&country=JP&provider=google&period=24h&offset=50`,
            );
            await expect(page.locator("#error-message")).toBeVisible();
            await expect(page.locator("#error-message")).toHaveText(malicious);
            await expect(page.locator("#error-message img")).toHaveCount(0);
            await expect(page.locator("#retry-btn")).toBeEnabled();
            assert.equal(calls.filter((call) => call.path === eventsPath).length, 1);
            await page.screenshot({
              path: path.join(reportDir, `error-${viewport.width}.png`),
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
              calls.filter((call) => call.path === eventsPath).length,
              2,
              "An in-flight retry must be guarded.",
            );
            retryGate.resolve();
            await expect(page.locator("#error-message")).toHaveText("Synthetic retry failure");
            await page.locator("#retry-btn").press("Space");
            await loaded(page, 1);
            await expect(page.locator("#error-message")).toBeHidden();
            await assertState(page, calls, { ...matchingFilters, period: "24h", offset: 50 });
            assert.equal(calls.filter((call) => call.path === eventsPath).length, 3);
          } finally {
            retryGate.resolve();
          }
        },
      );
    }

    await scenario(
      "Old or mismatched APIs cannot silently broaden a filtered investigation",
      viewports[1],
      async (route, url, n) => {
        const response = filteredResponse(url);
        if (n === 1) delete response.meta.applied_filters;
        if (n === 2) response.meta.applied_filters.user_id = "synthetic-other";
        await route.fulfill({ json: response });
      },
      async (page, calls, origin) => {
        await page.goto(`${origin}/security/events?user_id=synthetic-match`);
        await expect(page.locator("#error-message")).toContainText(
          "検索条件の適用を確認できませんでした",
        );
        await expect(page.locator("#table-wrap")).toBeHidden();
        await expect(page.locator("#events-tbody tr")).toHaveCount(0);
        await expect(page.locator("#events-summary")).toHaveText("イベントを表示できませんでした");
        await assertState(page, calls, { user_id: "synthetic-match" });
        await page.locator("#retry-btn").click();
        await expect.poll(() => calls.filter((call) => call.path === eventsPath).length).toBe(2);
        await expect(page.locator("#retry-btn")).toBeEnabled();
        await expect(page.locator("#loading")).toBeHidden();
        await expect(page.locator("#error-message")).toContainText(
          "検索条件の適用を確認できませんでした",
        );
        await expect(page.locator("#table-wrap")).toBeHidden();
        await expect(page.locator("#events-tbody tr")).toHaveCount(0);
        await expect(page.locator("#events-summary")).toHaveText("イベントを表示できませんでした");
        await assertState(page, calls, { user_id: "synthetic-match" });
        await page.locator("#retry-btn").click();
        await loaded(page, 50);
        await assertState(page, calls, { user_id: "synthetic-match" });
        assert.equal(calls.filter((call) => call.path === eventsPath).length, 3);
      },
    );

    const staleGate = deferred();
    await scenario(
      "Superseded requests are aborted and stale success cannot overwrite current results",
      viewports[1],
      async (route, url, n) => {
        if (n === 1) {
          await staleGate.promise;
          await route
            .fulfill({
              json: {
                data: [event(1, { user_id: "synthetic-stale" })],
                meta: { total: 1, limit: 50, offset: 0 },
              },
            })
            .catch(() => {});
        } else await defaultResponse(route, url);
      },
      async (page, calls, origin) => {
        try {
          await page.goto(`${origin}/security/events`, { waitUntil: "domcontentloaded" });
          await expect(page.locator("#loading")).toBeVisible();
          await expect.poll(() => calls.filter((call) => call.path === eventsPath).length).toBe(1);
          await fillFilters(page, { ...matchingFilters, period: "24h" });
          await page.locator("#apply-filters").click();
          await loaded(page, 50);
          await assertState(page, calls, { ...matchingFilters, period: "24h" });
          assert(
            (await page.evaluate(() => window.__syntheticAborts.length)) >= 1,
            "Superseded reads must cancel their AbortSignal.",
          );
          staleGate.resolve();
          await page.waitForTimeout(150);
          await loaded(page, 50);
          await expect(page.locator("#events-tbody")).not.toContainText("synthetic-stale");
          await expect(page.locator("#error-message")).toBeHidden();
        } finally {
          staleGate.resolve();
        }
      },
    );

    const unabortableGate = deferred();
    await scenario(
      "Sequence guard rejects a late response even when a transport ignores cancellation",
      viewports[1],
      async (route, url, n) => {
        if (n === 1) {
          await unabortableGate.promise;
          await route.fulfill({
            json: {
              data: [event(1, { user_id: "synthetic-stale" })],
              meta: { total: 1, limit: 50, offset: 0 },
            },
          });
        } else await defaultResponse(route, url);
      },
      async (page, calls, origin) => {
        try {
          await page.goto(`${origin}/security/events`, { waitUntil: "domcontentloaded" });
          await expect.poll(() => calls.filter((call) => call.path === eventsPath).length).toBe(1);
          await fillFilters(page, { ...matchingFilters, period: "30d" });
          await page.locator("#apply-filters").click();
          await loaded(page, 50);
          await assertState(page, calls, { ...matchingFilters, period: "30d" });
          assert((await page.evaluate(() => window.__syntheticAborts.length)) >= 1);
          unabortableGate.resolve();
          await page.waitForTimeout(150);
          await loaded(page, 50);
          await expect(page.locator("#events-tbody")).not.toContainText("synthetic-stale");
          await expect(page.locator("#error-message")).toBeHidden();
        } finally {
          unabortableGate.resolve();
        }
      },
      { ignoreFirstAbort: true },
    );

    await scenario(
      "Malformed URL filters never broaden reads and reset restores a valid query",
      viewports[1],
      defaultResponse,
      async (page, calls, origin) => {
        const invalidQueries = [
          "user=synthetic-match",
          "user_id=synthetic-match&user_id=synthetic-other",
          "user_id=",
          `user_id=${"a".repeat(129)}`,
          "user_id=%E6%97%A5%E6%9C%AC",
          "country=jp",
          "country=USA",
          "country=",
          "provider=unsupported",
          "period=1d",
          "offset=-1",
          "offset=0.5",
          "offset=9007199254740992",
          `user_id=${"a".repeat(2049)}`,
        ];
        for (const query of invalidQueries) {
          await page.goto(`${origin}/security/events?${query}`);
          await expect(page.locator("#error-message")).toBeVisible();
          await expect(page.locator("#table-wrap")).toBeHidden();
          await expect(page.locator("#loading")).toBeHidden();
          assert.equal(
            calls.filter((call) => call.path === eventsPath).length,
            0,
            "Invalid URL filters must not trigger an unfiltered API read.",
          );
        }
        await page.locator("#retry-btn").press("Enter");
        await expect(page.locator("#error-message")).toBeVisible();
        assert.equal(calls.filter((call) => call.path === eventsPath).length, 0);
        await page.locator("#reset-filters").press("Enter");
        await loaded(page, 50);
        await assertState(page, calls, {});
        await expect(page.locator("#filter-user")).toHaveAttribute("maxlength", "128");
        await fillFilters(page, { user_id: "a".repeat(128) });
        await page.locator("#apply-filters").click();
        await loaded(page, 0);
        await assertState(page, calls, { user_id: "a".repeat(128) });
        const reads = calls.filter((call) => call.path === eventsPath).length;
        await page.locator("#filter-user").fill("invalid <id>");
        await page.locator("#apply-filters").click();
        await page.waitForTimeout(80);
        assert.equal(
          calls.filter((call) => call.path === eventsPath).length,
          reads,
          "Invalid ASCII user IDs must not reach the API.",
        );
        await page.locator("#reset-filters").click();
        await loaded(page, 50);
        await page.locator("#filter-country").fill("jpn");
        const beforeCountry = calls.filter((call) => call.path === eventsPath).length;
        await page.locator("#apply-filters").click();
        await expect(page.locator("#error-message")).toBeVisible();
        assert.equal(calls.filter((call) => call.path === eventsPath).length, beforeCountry);
        await page.locator("#reset-filters").click();
        await loaded(page, 50);
        await fillFilters(page, {
          ...matchingFilters,
          user_id: "  synthetic-match  ",
          country: "jp",
          period: "7d",
        });
        await page.locator("#apply-filters").click();
        await loaded(page, 50);
        await assertState(page, calls, { ...matchingFilters, period: "7d" });
      },
    );

    await scenario(
      "Out-of-range filtered pages replace the URL with the last page or an empty first page",
      viewports[1],
      defaultResponse,
      async (page, calls, origin) => {
        await page.goto(
          `${origin}/security/events?user_id=synthetic-match&country=JP&provider=google&period=24h&offset=100`,
        );
        await loaded(page, 1);
        await assertState(page, calls, { ...matchingFilters, period: "24h", offset: 50 });
        assert.deepEqual(
          calls.filter((call) => call.path === eventsPath).map((call) => call.query.offset),
          ["100", "50"],
        );
        await page.goto(
          `${origin}/security/events?user_id=synthetic-no-matches&period=7d&offset=50`,
        );
        await loaded(page, 0);
        await assertState(page, calls, { user_id: "synthetic-no-matches", period: "7d" });
        assert.deepEqual(
          calls
            .filter((call) => call.path === eventsPath)
            .slice(-2)
            .map((call) => call.query.offset),
          ["50", "0"],
        );
        await expect(page.locator("#empty-message")).toBeVisible();
      },
    );

    await scenario(
      "A network failure preserves filters and keyboard retry recovers",
      viewports[0],
      (route, url, n) => (n === 1 ? route.abort("failed") : defaultResponse(route, url)),
      async (page, calls, origin) => {
        await page.goto(
          `${origin}/security/events?user_id=synthetic-match&country=JP&provider=google&period=30d`,
        );
        await expect(page.locator("#error-message")).toBeVisible();
        await page.locator("#retry-btn").press("Space");
        await loaded(page, 50);
        await assertState(page, calls, { ...matchingFilters, period: "30d" });
        assert.equal(calls.filter((call) => call.path === eventsPath).length, 2);
      },
    );

    await scenario(
      "Unauthorized reads retain the existing sign-in navigation",
      viewports[1],
      (route) => route.fulfill({ status: 401, json: { error: { code: "UNAUTHORIZED" } } }),
      async (page, calls, origin) => {
        await page.goto(`${origin}/security/events?period=24h`);
        await expect(page).toHaveURL(`${origin}/`);
        assert.equal(calls.filter((call) => call.path === eventsPath).length, 1);
      },
    );

    await scenario(
      "Untrusted event fields are escaped and user links are URL-encoded",
      viewports[0],
      (route) =>
        route.fulfill({
          json: {
            data: [
              event(1, {
                user_id: malicious,
                provider: malicious,
                ip_address: malicious,
                country: malicious,
                user_agent: malicious,
              }),
            ],
            meta: { limit: 50, offset: 0, total: 1 },
          },
        }),
      async (page, calls, origin) => {
        await page.goto(`${origin}/security/events`);
        await loaded(page, 1);
        await expect(
          page.locator("#events-tbody img, #events-tbody script, #events-tbody [onerror]"),
        ).toHaveCount(0);
        const cells = page.locator("#events-tbody td");
        for (const i of [1, 2, 3, 4]) await expect(cells.nth(i)).toHaveText(malicious);
        await expect(cells.nth(5)).toHaveAttribute("title", malicious);
        await expect(cells.nth(1).locator("a")).toHaveAttribute(
          "href",
          `/users/${encodeURIComponent(malicious)}`,
        );
        assert.equal(calls.filter((call) => call.path === eventsPath).length, 1);
      },
    );

    for (const viewport of viewports) {
      await scenario(
        "Suspicious-user dashboard drilldown opens that user's 24-hour events",
        viewport,
        defaultResponse,
        async (page, calls, origin) => {
          await page.goto(`${origin}/security/dashboard`);
          await expect(page.locator("#suspicious-tbody tr")).toHaveCount(2);
          await expect(
            page.locator(
              "#suspicious-tbody img, #suspicious-tbody script, #suspicious-tbody [onerror]",
            ),
          ).toHaveCount(0);
          await expect(page.locator("#suspicious-tbody tr").nth(1)).toContainText(malicious);
          const row = page.locator("#suspicious-tbody tr").first();
          const drilldown = row.locator('a[href^="/security/events?"]');
          await expect(drilldown).toHaveCount(1);
          const href = await drilldown.getAttribute("href");
          assertQuery(queryObject(new URL(href, origin)), {
            user_id: matchingFilters.user_id,
            period: "24h",
          });
          await drilldown.press("Enter");
          await loaded(page, 50);
          await assertState(page, calls, { user_id: matchingFilters.user_id, period: "24h" });
          await page.screenshot({
            path: path.join(reportDir, `drilldown-${viewport.width}.png`),
            fullPage: true,
          });
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
  console.log(`Security events UI: ${report.cases.length} synthetic browser cases passed`);
}

await main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
