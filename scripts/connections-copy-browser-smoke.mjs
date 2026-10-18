/* global window, navigator, document */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
const modulePath = process.env.CONNECTIONS_COPY_PLAYWRIGHT_MODULE;
if (!modulePath)
  throw new Error("Set CONNECTIONS_COPY_PLAYWRIGHT_MODULE to the CI-pinned Playwright install.");
const require = createRequire(import.meta.url);
const { chromium, expect } = require(modulePath);
assert.equal(require(path.join(modulePath, "package.json")).version, "1.57.0");
const root = path.resolve("workers/user/dist/client");
const reportDir = path.resolve(process.env.CONNECTIONS_COPY_REPORT_DIR || "connections-copy-ui");
const sub = "synthetic-sub-" + "a".repeat(64);
const report = {
  sourceCommit: process.env.GITHUB_SHA || null,
  runId: process.env.GITHUB_RUN_ID || null,
  node: process.version,
  scope:
    "Built connections page; synthetic GET only; clipboard mocked without permission requests; all mutations blocked",
  cases: [],
  status: "running",
};
await mkdir(reportDir, { recursive: true });
report.htmlSha256 = createHash("sha256")
  .update(await readFile(path.join(root, "connections/index.html")))
  .digest("hex");
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (req.method !== "GET" || pathname.startsWith("/api/")) return void res.writeHead(405).end();
  const relative = !path.extname(pathname) ? `${pathname}/index.html` : pathname;
  const filename = path.resolve(root, `.${decodeURIComponent(relative)}`);
  if (!filename.startsWith(root + path.sep)) return void res.writeHead(400).end();
  try {
    const content = await readFile(filename);
    res
      .writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
          }[path.extname(filename)] || "application/octet-stream",
        "Cache-Control": "no-store",
      })
      .end(content);
  } catch {
    res.writeHead(404).end();
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
  for (const width of [390, 1280])
    for (const mode of ["success", "denied", "unavailable", "delayed"]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [],
        mutations = [],
        reads = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (request.method() !== "GET") {
          mutations.push(request.method() + " " + url.pathname);
          return route.abort();
        }
        if (url.origin !== origin) return route.abort();
        if (url.pathname === "/api/connections") {
          reads.push(url.pathname);
          return route.fulfill({
            json: {
              data: [
                {
                  service_id: "synthetic-service",
                  service_name: "Synthetic service",
                  first_authorized_at: "2026-10-01T00:00:00Z",
                  pairwise_sub: sub,
                },
                ...(mode === "delayed"
                  ? [
                      {
                        service_id: "synthetic-service-two",
                        service_name: "Synthetic service two",
                        first_authorized_at: "2026-10-01T00:00:00Z",
                        pairwise_sub: sub + "-two",
                      },
                    ]
                  : []),
              ],
            },
          });
        }
        if (url.pathname.startsWith("/api/"))
          throw new Error("Unexpected API read " + url.pathname);
        return route.continue();
      });
      await page.addInitScript(
        ({ mode }) => {
          window.__copyCalls = [];
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value:
              mode === "unavailable"
                ? undefined
                : {
                    writeText: async (value) => {
                      window.__copyCalls.push(value);
                      if (mode === "delayed" && window.__copyCalls.length === 1)
                        await new Promise((_resolve, reject) => {
                          window.__rejectCopy = reject;
                        });
                      if (mode === "denied")
                        throw new DOMException("Synthetic clipboard denial", "NotAllowedError");
                    },
                  },
          });
        },
        { mode },
      );
      await page.goto(origin + "/connections/");
      const copy = page.getByRole("button", { name: "コピー", exact: true }).first();
      await expect(copy).toBeVisible();
      await copy.focus();
      await page.keyboard.press("Enter");
      const status = page.locator(".copy-status").first();
      if (mode === "delayed") {
        await expect(copy).toBeDisabled();
        await copy.dispatchEvent("click");
        assert.deepEqual(await page.evaluate(() => window.__copyCalls), [sub]);
        const back = page.getByRole("link", { name: "← プロフィール" });
        await back.focus();
        await page.evaluate(() =>
          window.__rejectCopy(new DOMException("Synthetic", "NotAllowedError")),
        );
        await expect(status).toContainText("コピーできませんでした");
        await expect(back).toBeFocused();
        await expect(page.getByRole("textbox", { name: "Sub ID（手動コピー用）" })).toHaveValue(
          sub,
        );
        const second = page.getByRole("button", { name: "コピー", exact: true }).nth(1);
        await second.focus();
        await page.keyboard.press("Space");
        await expect(page.locator(".copy-status").nth(1)).toHaveText("Sub ID をコピーしました。");
        await copy.focus();
        await page.keyboard.press("Enter");
        await expect(status).toHaveText("Sub ID をコピーしました。");
        assert.deepEqual(await page.evaluate(() => window.__copyCalls), [sub, sub + "-two", sub]);
        await expect(page.locator(".copy-recovery").first()).toBeHidden();
      } else if (mode === "success") {
        await expect(status).toHaveText("Sub ID をコピーしました。");
        await expect(page.locator(".copy-recovery")).toBeHidden();
        assert.deepEqual(await page.evaluate(() => window.__copyCalls), [sub]);
      } else {
        await expect(status).toContainText("コピーできませんでした");
        const input = page.getByRole("textbox", { name: "Sub ID（手動コピー用）" });
        await expect(input).toBeVisible();
        await expect(input).toHaveValue(sub);
        await expect(input).toBeFocused();
        assert.equal(await input.getAttribute("readonly"), "");
        assert.deepEqual(await input.evaluate((el) => [el.selectionStart, el.selectionEnd]), [
          0,
          sub.length,
        ]);
        assert.equal(await page.getByText("Sub ID をコピーしました", { exact: true }).count(), 0);
        // Native keyboard can revisit the explicit copy button; retry is never automatic.
        assert.equal(
          await page.evaluate(() => window.__copyCalls.length),
          mode === "denied" ? 1 : 0,
        );
        await page.screenshot({
          path: path.join(reportDir, `copy-${mode}-${width}.png`),
          fullPage: true,
        });
      }
      await expect(copy).toBeEnabled();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false,
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(mutations, []);
      assert.deepEqual(reads, ["/api/connections"]);
      report.cases.push({
        name: `${mode}-${width}`,
        status: "passed",
        reads,
        mutations,
        pageErrors: errors,
      });
      await context.close();
    }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  throw error;
} finally {
  await writeFile(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log("Connections copy browser: 8 passed");
