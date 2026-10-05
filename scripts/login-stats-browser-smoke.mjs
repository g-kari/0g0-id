/* global document, window, MouseEvent, PageTransitionEvent */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const playwrightModule = process.env.LOGIN_STATS_PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  throw new Error("Set LOGIN_STATS_PLAYWRIGHT_MODULE to the existing @playwright/test install.");
}
const require = createRequire(import.meta.url);
const { chromium, expect } = require(playwrightModule);
const playwrightVersion = require(path.join(playwrightModule, "package.json")).version;
assert.equal(playwrightVersion, "1.57.0", "Use the CI-pinned browser test toolchain.");
const staticRoot = path.resolve("workers/user/dist/client");
const reportDir = path.resolve(process.env.LOGIN_STATS_REPORT_DIR || "login-stats-ui");
const providersPath = "/api/me/login-stats";
const trendsPath = "/api/me/security/login-trends";
const apiPaths = [providersPath, trendsPath];
const mobile = { width: 320, height: 740 };
const desktop = { width: 1280, height: 900 };
const standard = { width: 390, height: 844 };
const malicious =
  '<img src="/synthetic-xss" onerror="window.__syntheticXss=1"> & "<script>bad</script>';
const report = {
  sourceCommit: process.env.GITHUB_SHA || null,
  runId: process.env.GITHUB_RUN_ID || null,
  node: process.version,
  playwright: playwrightVersion,
  scope:
    "Actual built user login-stats UI; synthetic paired GET responses; exact-origin network guard",
  observer:
    "Native fetch arguments and response bodies are preserved. JSON completion and failed fetches are observed with a next-task marker so released stale reads finish before assertions.",
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

function fixture(label, count = 12) {
  return {
    providers: [
      { provider: `${label}-small`, count: 1 },
      { provider: label, count },
    ],
    trends: [
      { date: "2026-10-03", count: 1 },
      { date: "2026-10-05", count },
    ],
  };
}

async function succeed(route, call, data = fixture(`period-${call.days}`, Number(call.days))) {
  await route.fulfill({
    json: { data: call.path === providersPath ? data.providers : data.trends },
  });
}

async function fail(route, status = 503) {
  // Ordinary failures must not activate TOKEN_ROTATED or DBSC transport retries.
  await route.fulfill({
    status,
    json: { error: { code: "SYNTHETIC_STATS_FAILURE", message: "Synthetic read failure" } },
  });
}

async function pending(page) {
  await expect(page.locator("#loading")).toBeVisible();
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#empty")).toBeHidden();
  await expect(page.locator("#providers-card")).toBeHidden();
  await expect(page.locator("#trends-card")).toBeHidden();
  await expect(page.locator("#stats-retry-btn")).toBeDisabled();
  await expect(page.locator("#days-select")).toBeEnabled();
}

async function failed(page) {
  await expect(page.locator("#error")).toBeVisible();
  await expect(page.locator("#stats-error-message")).toHaveText("ログイン統計の取得に失敗しました");
  await expect(page.locator("#loading")).toBeHidden();
  await expect(page.locator("#empty")).toBeHidden();
  await expect(page.locator("#providers-card")).toBeHidden();
  await expect(page.locator("#trends-card")).toBeHidden();
  await expect(page.getByRole("button", { name: "もう一度読み込む", exact: true })).toBeEnabled();
}

async function empty(page) {
  await expect(page.locator("#empty")).toBeVisible();
  await expect(page.locator("#loading")).toBeHidden();
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#providers-card")).toBeHidden();
  await expect(page.locator("#trends-card")).toBeHidden();
}

async function loaded(page, days, data) {
  await expect(page.locator("#days-select")).toHaveValue(String(days));
  await expect(page.locator("#loading")).toBeHidden();
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#empty")).toBeHidden();
  await expect(page.locator("#providers-card")).toBeVisible();
  await expect(page.locator("#trends-card")).toBeVisible();
  await expect(page.locator("#trends-title")).toHaveText(`直近 ${days}日のトレンド`);
  const sorted = [...data.providers].sort((a, b) => b.count - a.count);
  await expect(page.locator("#total-count")).toHaveText(
    String(sorted.reduce((sum, row) => sum + row.count, 0)),
  );
  await expect(page.locator("#top-provider")).toHaveText(
    sorted.length ? `${sorted[0].provider} (${sorted[0].count})` : "-",
  );
  const providerBars = page.locator('#providers-list [role="progressbar"]');
  await expect(providerBars).toHaveCount(sorted.length);
  for (let index = 0; index < sorted.length; index++) {
    const row = sorted[index];
    await expect(providerBars.nth(index)).toHaveAttribute(
      "aria-label",
      `${row.provider} のログイン回数`,
    );
    await expect(providerBars.nth(index)).toHaveAttribute("aria-valuenow", String(row.count));
    await expect(providerBars.nth(index)).toHaveAttribute("aria-valuemin", "0");
    await expect(providerBars.nth(index)).toHaveAttribute(
      "aria-valuemax",
      String(sorted[0].count || 1),
    );
    assert.equal(
      await providerBars
        .nth(index)
        .locator("div")
        .evaluate((bar) => bar.style.width),
      `${Math.max(2, Math.round((row.count / (sorted[0].count || 1)) * 100))}%`,
    );
  }
  if (!sorted.length) {
    await expect(page.locator("#providers-list")).toContainText("この期間のログインはありません");
  }
  const trendBars = page.locator('#trends-list [role="progressbar"]');
  const trends = [...data.trends].sort((a, b) => (a.date < b.date ? 1 : -1));
  await expect(trendBars).toHaveCount(trends.length);
  if (!trends.length) await expect(page.locator("#trends-empty")).toBeVisible();
  else await expect(page.locator("#trends-empty")).toBeHidden();
  const maxTrendCount = Math.max(1, ...trends.map((row) => row.count));
  for (let index = 0; index < trends.length; index++) {
    await expect(trendBars.nth(index)).toHaveAttribute(
      "aria-valuenow",
      String(trends[index].count),
    );
    await expect(trendBars.nth(index)).toHaveAttribute("aria-valuemin", "0");
    await expect(trendBars.nth(index)).toHaveAttribute("aria-valuemax", String(maxTrendCount));
    assert.equal(
      await trendBars
        .nth(index)
        .locator("div")
        .evaluate((bar) => bar.style.width),
      `${Math.max(2, Math.round((trends[index].count / maxTrendCount) * 100))}%`,
    );
  }
}

async function snapshot(page) {
  return page.evaluate(() => {
    const ids = [
      "loading",
      "error",
      "stats-error-message",
      "stats-retry-btn",
      "empty",
      "providers-card",
      "providers-list",
      "total-count",
      "top-provider",
      "trends-card",
      "trends-title",
      "trends-list",
      "trends-empty",
    ];
    return {
      days: document.getElementById("days-select").value,
      focus: document.activeElement.id || document.activeElement.tagName,
      elements: Object.fromEntries(
        ids.map((id) => {
          const element = document.getElementById(id);
          return [
            id,
            {
              display: element.style.display,
              text: element.textContent,
              html: element.innerHTML,
              disabled: element.disabled ?? null,
            },
          ];
        }),
      ),
    };
  });
}

async function settled(page, indices, paths = apiPaths) {
  const keys = indices.flatMap((index) => paths.map((apiPath) => `${apiPath}:${index}`));
  await page.waitForFunction(
    (expected) => expected.every((key) => window.__statsFixtureSettled.includes(key)),
    keys,
  );
}

function assertPairs(calls, days) {
  for (const apiPath of apiPaths) {
    assert.deepEqual(
      calls.filter((call) => call.path === apiPath).map((call) => call.days),
      days.map(String),
      "Each generation needs exactly one read from each endpoint for its selected period.",
    );
  }
}

async function select(page, calls, days, index) {
  await page.locator("#days-select").selectOption(String(days));
  await expect.poll(() => calls.filter((call) => call.index === index).length).toBe(2);
  assert(calls.filter((call) => call.index === index).every((call) => call.days === String(days)));
}

async function noOverflow(page) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    "The statistics and recovery panels must not overflow horizontally.",
  );
}

async function main() {
  await mkdir(reportDir, { recursive: true });
  report.statsHtmlSha256 = createHash("sha256")
    .update(await readFile(path.join(staticRoot, "login-stats/index.html")))
    .digest("hex");
  const server = createServer(async (req, res) => {
    // There are no API proxies, credentials, production data, or writable routes.
    let filename;
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (req.method !== "GET" || pathname.startsWith("/api/")) {
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
      ...(process.env.LOGIN_STATS_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.LOGIN_STATS_CHROMIUM_EXECUTABLE }
        : {}),
    });
    report.browser = await browser.version();
    report.browserExecutableOverride = process.env.LOGIN_STATS_CHROMIUM_EXECUTABLE || null;

    async function scenario(name, viewport, respond, check) {
      const context = await browser.newContext({
        viewport,
        serviceWorkers: "block",
        timezoneId: "UTC",
      });
      const calls = [];
      const pageErrors = [];
      const forbiddenWrites = [];
      const unexpectedReads = [];
      const blockedOrigins = new Set();
      const requestFailures = [];
      const transitions = [];
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("requestfailed", (request) => {
        const url = new URL(request.url());
        if (apiPaths.includes(url.pathname)) {
          requestFailures.push({ path: url.pathname, error: request.failure()?.errorText });
        }
      });
      await context.exposeBinding("recordStatsPageTransition", (_, transition) => {
        transitions.push(transition);
      });
      await context.addInitScript(
        ({ paths }) => {
          window.__syntheticXss = 0;
          window.__statsFixtureSettled = [];
          const counts = {};
          const nativeFetch = window.fetch.bind(window);
          window.fetch = (...args) => {
            const input = args[0];
            const url = new URL(
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
              window.location.href,
            );
            if (!paths.includes(url.pathname)) return nativeFetch(...args);
            counts[url.pathname] = (counts[url.pathname] || 0) + 1;
            const key = `${url.pathname}:${counts[url.pathname]}`;
            const mark = () => setTimeout(() => window.__statsFixtureSettled.push(key), 0);
            return nativeFetch(...args).then(
              (response) => {
                const nativeJson = response.json.bind(response);
                response.json = (...jsonArgs) =>
                  nativeJson(...jsonArgs).then(
                    (body) => {
                      mark();
                      return body;
                    },
                    (error) => {
                      mark();
                      throw error;
                    },
                  );
                return response;
              },
              (error) => {
                mark();
                throw error;
              },
            );
          };
          window.addEventListener("pageshow", (event) => {
            void window.recordStatsPageTransition({
              persisted: event.persisted,
              href: window.location.href,
              days: document.getElementById("days-select")?.value || null,
              trusted: event.isTrusted,
            });
          });
        },
        { paths: apiPaths },
      );
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
          if (!apiPaths.includes(url.pathname)) {
            unexpectedReads.push(url.pathname);
            await route.abort();
            return;
          }
          assert.deepEqual([...url.searchParams.keys()], ["days"]);
          assert(["7", "30", "90", "365"].includes(url.searchParams.get("days")));
          const call = {
            method: request.method(),
            path: url.pathname,
            days: url.searchParams.get("days"),
            index: calls.filter((entry) => entry.path === url.pathname).length + 1,
          };
          calls.push(call);
          await respond(route, call);
          return;
        }
        if (url.pathname === "/synthetic-xss") {
          unexpectedReads.push(url.pathname);
          await route.abort();
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
        requestFailures,
        transitions,
        status: "running",
      };
      report.cases.push(caseReport);
      try {
        await check(page, calls, origin, caseReport);
        assert.deepEqual(forbiddenWrites, [], "No account writes may occur.");
        assert.deepEqual(unexpectedReads, [], "Only the two exact synthetic API reads may occur.");
        assert.deepEqual(pageErrors, [], "No uncaught page errors may occur.");
        assert.equal(await page.evaluate(() => window.__syntheticXss), 0);
        caseReport.status = "passed";
        console.log(`PASS ${viewport.width}px: ${name}`);
      } catch (error) {
        caseReport.status = "failed";
        caseReport.error = error instanceof Error ? error.stack : String(error);
        await page
          .screenshot({
            path: path.join(reportDir, `failed-${report.cases.length}-${viewport.width}.png`),
            fullPage: true,
          })
          .catch(() => {});
        throw error;
      } finally {
        caseReport.blockedOrigins = [...blockedOrigins];
        await context.close();
      }
    }

    for (const viewport of [mobile, desktop]) {
      const retryGate = deferred();
      const recoveryGate = deferred();
      await scenario(
        "Keyboard retry, repeated failure, guarded pair and recovery",
        viewport,
        async (route, call) => {
          if (call.index === 1) await fail(route);
          else if (call.index === 2) {
            await retryGate.promise;
            await fail(route, 500);
          } else {
            await recoveryGate.promise;
            await succeed(route, call, fixture("recovered", 30));
          }
        },
        async (page, calls, localOrigin) => {
          try {
            await page.goto(`${localOrigin}/login-stats`);
            await failed(page);
            await settled(page, [1]);
            await expect(page.locator("#loading")).toHaveAttribute("role", "status");
            await expect(page.locator("#loading .spinner")).toHaveAttribute("aria-hidden", "true");
            await expect(page.locator("#stats-error-message")).toHaveAttribute("role", "alert");
            await expect(page.locator("#stats-retry-btn")).toHaveAttribute("type", "button");
            assert(
              await page.locator("#days-select").evaluate((control) => control.labels.length > 0),
            );
            await expect(page.locator('a[href="/profile"]')).toBeVisible();
            await page.waitForTimeout(650);
            assertPairs(calls, [30]);
            await noOverflow(page);
            await page.screenshot({
              path: path.join(reportDir, `error-${viewport.width}.png`),
              fullPage: true,
            });
            await page.locator("#stats-retry-btn").press("Enter");
            await pending(page);
            await page.evaluate(() => {
              const button = document.getElementById("stats-retry-btn");
              button.dispatchEvent(new MouseEvent("click"));
              button.dispatchEvent(new MouseEvent("click"));
            });
            await page.locator("#days-select").focus();
            retryGate.resolve();
            await failed(page);
            await settled(page, [2]);
            assertPairs(calls, [30, 30]);
            await expect(page.locator("#days-select")).toBeFocused();
            await page.screenshot({
              path: path.join(reportDir, `retry-error-${viewport.width}.png`),
              fullPage: true,
            });
            await page.locator("#stats-retry-btn").press("Space");
            await pending(page);
            await page.locator('a[href="/profile"]').focus();
            recoveryGate.resolve();
            await loaded(page, 30, fixture("recovered", 30));
            await settled(page, [3]);
            await expect(page.locator('a[href="/profile"]')).toBeFocused();
            assertPairs(calls, [30, 30, 30]);
            await page.evaluate(() =>
              document.getElementById("stats-retry-btn").dispatchEvent(new MouseEvent("click")),
            );
            await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
            assertPairs(calls, [30, 30, 30]);
            await noOverflow(page);
            await page.screenshot({
              path: path.join(reportDir, `recovered-${viewport.width}.png`),
              fullPage: true,
            });
          } finally {
            retryGate.resolve();
            recoveryGate.resolve();
          }
        },
      );
    }

    await scenario(
      "Initial success, all four periods and native keyboard selector preserve focus",
      standard,
      (route, call) => succeed(route, call),
      async (page, calls, localOrigin) => {
        await page.goto(`${localOrigin}/login-stats`);
        await loaded(page, 30, fixture("period-30", 30));
        await settled(page, [1]);
        assert.equal(await page.evaluate(() => document.activeElement.tagName), "BODY");
        await page.locator("#days-select").focus();
        await page.keyboard.press("Home");
        await page.keyboard.press("Enter");
        await loaded(page, 7, fixture("period-7", 7));
        await settled(page, [2]);
        await expect(page.locator("#days-select")).toBeFocused();
        for (const [index, days] of [
          [3, 30],
          [4, 90],
          [5, 365],
        ]) {
          await select(page, calls, days, index);
          await loaded(page, days, fixture(`period-${days}`, days));
          await settled(page, [index]);
          await expect(page.locator("#days-select")).toBeFocused();
        }
        assertPairs(calls, [30, 7, 30, 90, 365]);
      },
    );

    for (const oldOutcome of ["success", "failure", "empty"]) {
      for (const timing of ["before", "after"]) {
        const oldGate = deferred();
        const newGate = deferred();
        await scenario(
          `Stale ${oldOutcome} completes ${timing} latest pair`,
          standard,
          async (route, call) => {
            if (call.index === 1) return succeed(route, call);
            if (call.index === 2) {
              await oldGate.promise;
              if (oldOutcome === "failure") return fail(route);
              return succeed(
                route,
                call,
                oldOutcome === "empty" ? { providers: [], trends: [] } : fixture("obsolete-7", 7),
              );
            }
            await newGate.promise;
            return succeed(route, call, fixture("latest-90", 90));
          },
          async (page, calls, localOrigin, caseReport) => {
            try {
              await page.goto(`${localOrigin}/login-stats`);
              await loaded(page, 30, fixture("period-30", 30));
              await select(page, calls, 7, 2);
              await select(page, calls, 90, 3);
              await page.locator("#days-select").focus();
              await pending(page);
              if (timing === "before") {
                const before = await snapshot(page);
                oldGate.resolve();
                await settled(page, [2]);
                assert.deepEqual(
                  await snapshot(page),
                  before,
                  "A stale pair cannot change latest pending state.",
                );
                newGate.resolve();
                await loaded(page, 90, fixture("latest-90", 90));
                await settled(page, [3]);
              } else {
                newGate.resolve();
                await loaded(page, 90, fixture("latest-90", 90));
                await settled(page, [3]);
                const before = await snapshot(page);
                oldGate.resolve();
                await settled(page, [2]);
                assert.deepEqual(
                  await snapshot(page),
                  before,
                  "A stale pair cannot change the latest terminal state.",
                );
              }
              await expect(page.locator("#days-select")).toBeFocused();
              assertPairs(calls, [30, 7, 90]);
              caseReport.finalState = await snapshot(page);
            } finally {
              oldGate.resolve();
              newGate.resolve();
            }
          },
        );
      }
    }

    const firstSeven = deferred();
    const middleNinety = deferred();
    await scenario(
      "7 to 90 to 7 uses generation identity even with equal periods",
      standard,
      async (route, call) => {
        if (call.index === 2) {
          await firstSeven.promise;
          return succeed(route, call, fixture("first-7", 7));
        }
        if (call.index === 3) {
          await middleNinety.promise;
          return succeed(route, call, fixture("middle-90", 90));
        }
        return succeed(route, call, fixture(call.index === 4 ? "latest-second-7" : "initial", 700));
      },
      async (page, calls, localOrigin) => {
        try {
          await page.goto(`${localOrigin}/login-stats`);
          await loaded(page, 30, fixture("initial", 700));
          await select(page, calls, 7, 2);
          await select(page, calls, 90, 3);
          await select(page, calls, 7, 4);
          await loaded(page, 7, fixture("latest-second-7", 700));
          await settled(page, [4]);
          const before = await snapshot(page);
          firstSeven.resolve();
          await settled(page, [2]);
          assert.deepEqual(await snapshot(page), before);
          middleNinety.resolve();
          await settled(page, [3]);
          assert.deepEqual(await snapshot(page), before);
          assertPairs(calls, [30, 7, 90, 7]);
          await page.screenshot({
            path: path.join(reportDir, "latest-generation.png"),
            fullPage: true,
          });
        } finally {
          firstSeven.resolve();
          middleNinety.resolve();
        }
      },
    );

    for (const latestOutcome of ["failure", "empty"]) {
      const oldGate = deferred();
      await scenario(
        `Latest ${latestOutcome} remains authoritative after obsolete success`,
        standard,
        async (route, call) => {
          if (call.index === 1) return succeed(route, call);
          if (call.index === 2) {
            await oldGate.promise;
            return succeed(route, call, fixture("obsolete-7", 7));
          }
          return latestOutcome === "failure"
            ? fail(route)
            : succeed(route, call, { providers: [], trends: [] });
        },
        async (page, calls, localOrigin) => {
          try {
            await page.goto(`${localOrigin}/login-stats`);
            await loaded(page, 30, fixture("period-30", 30));
            await select(page, calls, 7, 2);
            await select(page, calls, 90, 3);
            if (latestOutcome === "failure") await failed(page);
            else await empty(page);
            await settled(page, [3]);
            const before = await snapshot(page);
            oldGate.resolve();
            await settled(page, [2]);
            assert.deepEqual(await snapshot(page), before);
            assertPairs(calls, [30, 7, 90]);
          } finally {
            oldGate.resolve();
          }
        },
      );
    }

    for (const providersOutcome of ["nonempty", "empty", "failure"]) {
      for (const trendsOutcome of ["nonempty", "empty", "failure"]) {
        const data = fixture("pair", 30);
        if (providersOutcome === "empty") data.providers = [];
        if (trendsOutcome === "empty") data.trends = [];
        await scenario(
          `Endpoint pair: providers ${providersOutcome}, trends ${trendsOutcome}`,
          standard,
          (route, call) =>
            (call.path === providersPath ? providersOutcome : trendsOutcome) === "failure"
              ? fail(route)
              : succeed(route, call, data),
          async (page, calls, localOrigin) => {
            await page.goto(`${localOrigin}/login-stats`);
            await settled(page, [1]);
            if ([providersOutcome, trendsOutcome].includes("failure")) await failed(page);
            else if (!data.providers.length && !data.trends.length) await empty(page);
            else await loaded(page, 30, data);
            assertPairs(calls, [30]);
          },
        );
      }
    }

    for (const heldPath of apiPaths) {
      const siblingGate = deferred();
      await scenario(
        `One completed endpoint waits for ${heldPath}`,
        standard,
        async (route, call) => {
          if (call.path === heldPath) await siblingGate.promise;
          await succeed(route, call);
        },
        async (page, calls, localOrigin) => {
          try {
            await page.goto(`${localOrigin}/login-stats`, { waitUntil: "domcontentloaded" });
            await settled(
              page,
              [1],
              apiPaths.filter((apiPath) => apiPath !== heldPath),
            );
            await pending(page);
            siblingGate.resolve();
            await loaded(page, 30, fixture("period-30", 30));
            await settled(page, [1]);
            assertPairs(calls, [30]);
          } finally {
            siblingGate.resolve();
          }
        },
      );
    }

    for (const lateOutcome of ["success", "failure"]) {
      const siblingGate = deferred();
      await scenario(
        `Retry recovers while old sibling remains pending, then late ${lateOutcome}`,
        standard,
        async (route, call) => {
          if (call.index === 1 && call.path === providersPath) return fail(route);
          if (call.index === 1) {
            await siblingGate.promise;
            return lateOutcome === "failure"
              ? fail(route)
              : succeed(route, call, fixture("obsolete-sibling", 9));
          }
          return succeed(route, call, fixture("retry-current", 30));
        },
        async (page, calls, localOrigin) => {
          try {
            await page.goto(`${localOrigin}/login-stats`, { waitUntil: "domcontentloaded" });
            await failed(page);
            await page.locator("#stats-retry-btn").press("Enter");
            await loaded(page, 30, fixture("retry-current", 30));
            await settled(page, [2]);
            const before = await snapshot(page);
            siblingGate.resolve();
            await settled(page, [1]);
            assert.deepEqual(await snapshot(page), before);
            assertPairs(calls, [30, 30]);
          } finally {
            siblingGate.resolve();
          }
        },
      );
    }

    const retryGate = deferred();
    await scenario(
      "A period change supersedes pending Retry without stealing selector focus",
      standard,
      async (route, call) => {
        if (call.index === 1) return fail(route);
        if (call.index === 2) {
          await retryGate.promise;
          return fail(route, 500);
        }
        return succeed(route, call, fixture("superseding-90", 90));
      },
      async (page, calls, localOrigin) => {
        try {
          await page.goto(`${localOrigin}/login-stats`);
          await failed(page);
          await page.locator("#stats-retry-btn").press("Enter");
          await pending(page);
          await select(page, calls, 90, 3);
          await page.locator("#days-select").focus();
          await loaded(page, 90, fixture("superseding-90", 90));
          await settled(page, [3]);
          const before = await snapshot(page);
          retryGate.resolve();
          await settled(page, [2]);
          assert.deepEqual(await snapshot(page), before);
          await expect(page.locator("#days-select")).toBeFocused();
          assertPairs(calls, [30, 30, 90]);
        } finally {
          retryGate.resolve();
        }
      },
    );

    await scenario(
      "Empty and partially empty sections recover without residual state",
      mobile,
      (route, call) => {
        const data = fixture("transitions", 30);
        if (call.index === 1) data.trends = [];
        if (call.index === 2) data.providers = [];
        if (call.index === 3) {
          data.providers = [];
          data.trends = [];
        }
        return succeed(route, call, data);
      },
      async (page, calls, localOrigin) => {
        await page.goto(`${localOrigin}/login-stats`);
        await loaded(page, 30, { providers: fixture("transitions", 30).providers, trends: [] });
        await select(page, calls, 7, 2);
        await loaded(page, 7, { providers: [], trends: fixture("transitions", 30).trends });
        await select(page, calls, 90, 3);
        await empty(page);
        await page.screenshot({ path: path.join(reportDir, "empty-320.png"), fullPage: true });
        await select(page, calls, 365, 4);
        await loaded(page, 365, fixture("transitions", 30));
        await settled(page, [1, 2, 3, 4]);
        assertPairs(calls, [30, 7, 90, 365]);
        await noOverflow(page);
      },
    );

    await scenario(
      "Untrusted provider content is escaped in text and accessibility labels",
      desktop,
      (route, call) =>
        succeed(route, call, {
          providers: [
            { provider: malicious, count: 100 },
            { provider: "zero", count: 0 },
          ],
          trends: [
            { date: "2026-10-05", count: 100 },
            { date: "2026-10-03", count: 0 },
          ],
        }),
      async (page, calls, localOrigin) => {
        const data = {
          providers: [
            { provider: malicious, count: 100 },
            { provider: "zero", count: 0 },
          ],
          trends: [
            { date: "2026-10-05", count: 100 },
            { date: "2026-10-03", count: 0 },
          ],
        };
        await page.goto(`${localOrigin}/login-stats`);
        await loaded(page, 30, data);
        await settled(page, [1]);
        await expect(
          page.locator(
            "#providers-list img, #providers-list script, #providers-list [onerror], #top-provider img, #top-provider script",
          ),
        ).toHaveCount(0);
        await expect(page.locator("#providers-list .font-semibold").first()).toHaveText(malicious);
        assertPairs(calls, [30]);
      },
    );

    for (const persisted of [false, true]) {
      await scenario(
        `Selector-only restoration reconciles pageshow persisted=${persisted}`,
        standard,
        (route, call) => succeed(route, call),
        async (page, calls, localOrigin) => {
          await page.goto(`${localOrigin}/login-stats`);
          await loaded(page, 30, fixture("period-30", 30));
          await settled(page, [1]);
          assertPairs(calls, [30]);
          await page.locator("#days-select").focus();
          await page.evaluate((restored) => {
            document.getElementById("days-select").value = "90";
            window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: restored }));
          }, persisted);
          await loaded(page, 90, fixture("period-90", 90));
          await settled(page, [2]);
          await expect(page.locator("#days-select")).toBeFocused();
          await page.evaluate(
            (restored) =>
              window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: restored })),
            persisted,
          );
          await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
          assertPairs(calls, [30, 90]);
        },
      );
    }

    for (const dispatchPageshow of [false, true]) {
      const selectorGate = deferred();
      await scenario(
        dispatchPageshow
          ? "Restored selector on pageshow supersedes an already pending pair"
          : "Response commit rechecks a selector changed without a change event",
        standard,
        async (route, call) => {
          if (call.index === 1) await selectorGate.promise;
          await succeed(route, call);
        },
        async (page, calls, localOrigin) => {
          try {
            await page.goto(`${localOrigin}/login-stats`, { waitUntil: "domcontentloaded" });
            await expect.poll(() => calls.length).toBe(2);
            await page.evaluate((show) => {
              document.getElementById("days-select").value = "365";
              if (show)
                window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
            }, dispatchPageshow);
            if (dispatchPageshow) {
              await loaded(page, 365, fixture("period-365", 365));
              await settled(page, [2]);
              const before = await snapshot(page);
              selectorGate.resolve();
              await settled(page, [1]);
              assert.deepEqual(await snapshot(page), before);
            } else {
              selectorGate.resolve();
              await loaded(page, 365, fixture("period-365", 365));
              await settled(page, [1, 2]);
            }
            assertPairs(calls, [30, 365]);
          } finally {
            selectorGate.resolve();
          }
        },
      );
    }

    await scenario(
      "Real back and forward preserve restored-selector and data consistency",
      standard,
      (route, call) => succeed(route, call),
      async (page, calls, localOrigin, caseReport) => {
        await page.goto(`${localOrigin}/login-stats`);
        await loaded(page, 30, fixture("period-30", 30));
        await select(page, calls, 90, 2);
        await loaded(page, 90, fixture("period-90", 90));
        await page.goto(`${localOrigin}/`);
        await expect(page.getByRole("link", { name: "Googleでサインイン" })).toBeVisible();
        await page.goBack();
        await expect(page).toHaveURL(`${localOrigin}/login-stats`);
        await page.waitForFunction(() => {
          const days = document.getElementById("days-select").value;
          return (
            document.getElementById("loading").style.display === "none" &&
            document.getElementById("trends-title").textContent === `直近 ${days}日のトレンド`
          );
        });
        const backDays = await page.locator("#days-select").inputValue();
        assert(["7", "30", "90", "365"].includes(backDays));
        await loaded(page, backDays, fixture(`period-${backDays}`, Number(backDays)));
        caseReport.restoredDays = backDays;
        await page.goForward();
        await expect(page).toHaveURL(`${localOrigin}/`);
        await page.goBack();
        await expect(page).toHaveURL(`${localOrigin}/login-stats`);
        await page.waitForFunction(() => {
          const days = document.getElementById("days-select").value;
          return (
            document.getElementById("loading").style.display === "none" &&
            document.getElementById("trends-title").textContent === `直近 ${days}日のトレンド`
          );
        });
        const finalDays = await page.locator("#days-select").inputValue();
        await loaded(page, finalDays, fixture(`period-${finalDays}`, Number(finalDays)));
        assert.deepEqual(
          calls.filter((call) => call.path === providersPath).map((call) => call.days),
          calls.filter((call) => call.path === trendsPath).map((call) => call.days),
        );
        assert.equal(calls.filter((call) => call.path === providersPath).at(-1).days, finalDays);
        caseReport.navigationNote =
          "Real browser history exercised; actual trusted pageshow events are recorded. Synthetic pageshow cases do not claim BFCache coverage.";
      },
    );

    await scenario(
      "Network failure keeps same-period keyboard Retry usable",
      standard,
      (route, call) => (call.index === 1 ? route.abort("failed") : succeed(route, call)),
      async (page, calls, localOrigin) => {
        await page.goto(`${localOrigin}/login-stats`);
        await failed(page);
        await settled(page, [1]);
        await page.locator("#stats-retry-btn").press("Enter");
        await loaded(page, 30, fixture("period-30", 30));
        await settled(page, [2]);
        assertPairs(calls, [30, 30]);
      },
    );

    await scenario(
      "Existing unauthorized redirect remains intact",
      standard,
      (route) => route.fulfill({ status: 401, json: { error: { code: "UNAUTHORIZED" } } }),
      async (page, calls, localOrigin) => {
        await page.goto(`${localOrigin}/login-stats`);
        await expect(page).toHaveURL(`${localOrigin}/`);
        await expect(page.getByRole("link", { name: "Googleでサインイン" })).toBeVisible();
        assertPairs(calls, [30]);
      },
    );

    const unauthorizedGate = deferred();
    await scenario(
      "A superseded 401 retains shared authentication navigation",
      standard,
      async (route, call) => {
        if (call.index === 1) {
          await unauthorizedGate.promise;
          return route.fulfill({ status: 401, json: { error: { code: "UNAUTHORIZED" } } });
        }
        return succeed(route, call);
      },
      async (page, calls, localOrigin) => {
        try {
          await page.goto(`${localOrigin}/login-stats`, { waitUntil: "domcontentloaded" });
          await expect.poll(() => calls.length).toBe(2);
          await select(page, calls, 90, 2);
          await loaded(page, 90, fixture("period-90", 90));
          await settled(page, [2]);
          unauthorizedGate.resolve();
          await expect(page).toHaveURL(`${localOrigin}/`);
          await expect(page.getByRole("link", { name: "Googleでサインイン" })).toBeVisible();
          assertPairs(calls, [30, 90]);
        } finally {
          unauthorizedGate.resolve();
        }
      },
    );
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    await writeFile(path.join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  console.log(`Login stats UI: ${report.cases.length} synthetic browser cases passed`);
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
