import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Uses only built Astro assets and synthetic GET responses. No Worker or real user data.
export async function usersStatusBrowserCases({ browser, expect, origin, staticRoot, reportDir }) {
  const active = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Synthetic active",
    email: "active@example.invalid",
    role: "user",
    banned_at: null,
    created_at: "2026-10-17T00:00:00Z",
  };
  const banned = {
    ...active,
    id: "22222222-2222-4222-8222-222222222222",
    name: "Synthetic banned",
    email: "banned@example.invalid",
    banned_at: "2026-10-17T01:00:00Z",
  };
  const users = [active, banned];
  const report = {
    sourceCommit: process.env.GITHUB_SHA || null,
    scope:
      "Built users page; synthetic users; all external requests blocked; no auth or BAN actions",
    htmlSha256: createHash("sha256")
      .update(await readFile(path.join(staticRoot, "users/index.html")))
      .digest("hex"),
    cases: [],
    status: "running",
  };
  const success = (route, rows) => route.fulfill({ json: { data: rows, total: rows.length } });
  const failure = (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: "INTERNAL_ERROR", message: "Synthetic error" } },
    });
  async function loaded(page, rows) {
    await expect(page.locator("#loading")).toBeHidden();
    await expect(page.locator("#error")).toBeHidden();
    await expect(page.locator("#table-wrap")).toBeVisible();
    await expect(page.locator("#user-count")).toHaveText(`${rows.length} 件`);
    await expect(page.locator("#user-tbody tr")).toHaveCount(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const cells = page.locator("#user-tbody tr").nth(i).locator("td");
      await expect(cells.nth(0)).toHaveText(rows[i].name);
      await expect(cells.nth(2)).toHaveText(rows[i].email);
      await expect(cells.nth(4)).toHaveText(rows[i].banned_at ? "BAN" : "アクティブ");
    }
    if (rows.length) await expect(page.locator("#empty-message")).toBeHidden();
    else await expect(page.locator("#empty-message")).toBeVisible();
  }
  async function scenario(name, respond, check) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const page = await context.newPage();
    const calls = [],
      unexpected = [],
      errors = [];
    const result = { name, calls, unexpected, errors, status: "running" };
    report.cases.push(result);
    page.on("pageerror", (error) => errors.push(error.message));
    await context.routeWebSocket("**/*", (socket) => {
      unexpected.push(`WebSocket ${socket.url()}`);
      socket.close();
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
      if (url.pathname === "/api/users") {
        calls.push(url.search);
        await respond(route, url, calls.length);
        return;
      }
      if (url.pathname === "/api/metrics/dbsc-bindings" && !url.search) {
        await route.fulfill({
          json: { data: { total: 0, device_bound: 0, unbound: 0, by_bff_origin: [] } },
        });
        return;
      }
      if (
        url.pathname === "/users" ||
        url.pathname.startsWith("/_astro/") ||
        /^\/favicon\.(svg|ico)$/.test(url.pathname)
      ) {
        await route.continue();
        return;
      }
      unexpected.push(`Unexpected read ${url.pathname}${url.search}`);
      await route.abort();
    });
    try {
      await page.goto(`${origin}/users`);
      await loaded(page, users);
      assert.deepEqual(calls, [""], "Initial read keeps the existing default pagination contract.");
      await check(page, calls);
      assert.deepEqual(unexpected, [], "Only built assets and synthetic GET APIs are allowed.");
      assert.deepEqual(errors, [], "No uncaught browser errors.");
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
      "all → active → banned → all; rows, status and count match the API",
      (route, url) => {
        const value = url.searchParams.get("banned");
        return success(
          route,
          users.filter((user) => value === null || Boolean(user.banned_at) === (value === "true")),
        );
      },
      async (page, calls) => {
        for (const [value, query, rows] of [
          ["active", "?banned=false", [active]],
          ["banned", "?banned=true", [banned]],
          ["all", "", users],
        ]) {
          const count = calls.length;
          await page.locator("#status-filter").selectOption(value);
          await expect.poll(() => calls.length).toBe(count + 1);
          assert.equal(calls.at(-1), query, "Use the existing BFF/IdP banned boolean query.");
          await loaded(page, rows);
        }
        await page.screenshot({
          path: path.join(reportDir, "users-status-all.png"),
          fullPage: true,
        });
      },
    );
    await scenario(
      "empty filtered result and subsequent recovery",
      (route, url) => success(route, url.search ? [] : users),
      async (page, calls) => {
        await page.locator("#status-filter").selectOption("banned");
        await loaded(page, []);
        assert.equal(calls.at(-1), "?banned=true");
        await page.locator("#status-filter").selectOption("all");
        await loaded(page, users);
      },
    );
    for (const outcome of ["success", "error"]) {
      let older;
      await scenario(
        `stale ${outcome} cannot replace newer results`,
        (route, _url, count) => {
          if (count === 2) {
            older = route;
            return;
          }
          return success(route, count === 1 ? users : [banned]);
        },
        async (page, calls) => {
          await page.locator("#status-filter").selectOption("active");
          await expect.poll(() => calls.length).toBe(2);
          await page.locator("#status-filter").selectOption("banned");
          await loaded(page, [banned]);
          assert.deepEqual(calls, ["", "?banned=false", "?banned=true"]);
          const settled = page.waitForResponse((response) =>
            response.url().endsWith("?banned=false"),
          );
          await (outcome === "success" ? success(older, [active]) : failure(older));
          await (await settled).finished();
          await page.waitForTimeout(100);
          await loaded(page, [banned]);
          await expect(page.locator("#status-filter")).toHaveValue("banned");
        },
      );
    }
    for (const outcome of ["success", "error"]) {
      let older, latest;
      await scenario(
        `stale ${outcome}/finally cannot clear the latest loading state`,
        (route, _url, count) => {
          if (count === 2) {
            older = route;
            return;
          }
          if (count === 3) {
            latest = route;
            return;
          }
          return success(route, users);
        },
        async (page, calls) => {
          await page.locator("#status-filter").selectOption("active");
          await expect.poll(() => calls.length).toBe(2);
          await page.locator("#status-filter").selectOption("banned");
          await expect.poll(() => calls.length).toBe(3);
          const settled = page.waitForResponse((response) =>
            response.url().endsWith("?banned=false"),
          );
          await (outcome === "success" ? success(older, [active]) : failure(older));
          await (await settled).finished();
          await page.waitForTimeout(100);
          await expect(page.locator("#loading")).toBeVisible();
          await expect(page.locator("#table-wrap")).toBeHidden();
          await expect(page.locator("#error")).toBeHidden();
          await expect(page.locator("#user-count")).toHaveText("2 件");
          await success(latest, [banned]);
          await loaded(page, [banned]);
        },
      );
    }
    for (const outcome of ["success", "error"]) {
      let older;
      await scenario(
        `stale ${outcome} cannot hide the latest error`,
        (route, _url, count) => {
          if (count === 2) {
            older = route;
            return;
          }
          return count === 3 ? failure(route) : success(route, users);
        },
        async (page, calls) => {
          await page.locator("#status-filter").selectOption("active");
          await expect.poll(() => calls.length).toBe(2);
          await page.locator("#status-filter").selectOption("banned");
          await expect(page.locator("#error")).toBeVisible();
          const currentError = await page.locator("#error").textContent();
          const settled = page.waitForResponse((response) =>
            response.url().endsWith("?banned=false"),
          );
          await (outcome === "success" ? success(older, [active]) : failure(older));
          await (await settled).finished();
          await page.waitForTimeout(100);
          await expect(page.locator("#error")).toHaveText(currentError);
          await expect(page.locator("#error")).toBeVisible();
          await expect(page.locator("#loading")).toBeHidden();
          await expect(page.locator("#table-wrap")).toBeHidden();
        },
      );
    }
    await scenario(
      "current error remains visible and a later filter recovers",
      (route, _url, count) => (count === 2 ? failure(route) : success(route, users)),
      async (page) => {
        await page.locator("#status-filter").selectOption("active");
        await expect(page.locator("#error")).toBeVisible();
        await expect(page.locator("#loading")).toBeHidden();
        await expect(page.locator("#table-wrap")).toBeHidden();
        await page.locator("#status-filter").selectOption("all");
        await loaded(page, users);
      },
    );
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    await writeFile(
      path.join(reportDir, "users-status-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return report;
}
