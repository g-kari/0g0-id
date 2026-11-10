/// <reference types="node" />
/** Synthetic, fully intercepted browser test. No provider requests or production data. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Hono } from "hono";
import { bffCsrfMiddleware, type BffEnv, type IdpEnv, type TokenPayload } from "@0g0-id/shared";
import { makeSessionCookie } from "../packages/shared/src/test-helpers/session";
import authRoutes from "../workers/user/src/routes/auth";
import { handleLogin } from "../workers/id/src/routes/auth/login";
import { handleLinkIntent } from "../workers/id/src/routes/auth/link-intent";

function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
  return message
    .replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
      try {
        return `${new URL(value).origin}/[redacted]`;
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted-value]")
    .slice(0, 600);
}

async function main() {
  const modulePath = process.env.SOCIAL_LOGIN_PLAYWRIGHT_MODULE;
  assert.ok(
    modulePath,
    "Set SOCIAL_LOGIN_PLAYWRIGHT_MODULE to the existing @playwright/test install",
  );
  const require = createRequire(import.meta.url);
  const { chromium } = require(modulePath);
  const version = require(path.join(modulePath, "package.json")).version;
  assert.equal(version, "1.57.0", "Use the CI-pinned Playwright toolchain");
  const USER = "https://user.0g0.xyz";
  const IDP = "https://id.0g0.xyz";
  const EVIL = "https://evil.example";
  const reportDir = path.resolve(
    process.env.SOCIAL_LOGIN_REPORT_DIR ?? "social-login-browser-smoke",
  );
  await mkdir(reportDir, { recursive: true });
  const report = {
    status: "running",
    node: process.version,
    playwright: version,
    browserSource: process.env.SOCIAL_LOGIN_CHROMIUM_EXECUTABLE
      ? "system-override"
      : "playwright-pinned",
    sourceCommit: process.env.GITHUB_SHA ?? null,
    scope:
      "Real BFF HTML, CSRF middleware, IdP link-intent/login handlers, synthetic session identity and SQLite; intercepted provider landing only; no callback exchange",
    cases: [] as {
      provider: string;
      scenario: string;
      status: string;
      stage?: string;
      errors?: string[];
      failure?: string;
      finalStatus?: number | null;
      postedOrigin?: string | null;
      idpPosts?: number;
      providerVisits?: number;
    }[],
  };
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
  sqlite.exec(
    await readFile(new URL("../docs/proposals/social-login-schema.sql", import.meta.url), "utf8"),
  );
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: SQLInputValue[]) {
          return {
            async first() {
              return sqlite.prepare(sql).get(...values) ?? null;
            },
            async all() {
              return { results: sqlite.prepare(sql).all(...values) };
            },
            async run() {
              return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
            },
          };
        },
      };
    },
  } as unknown as IdpEnv["DB"];
  const idpEnv = {
    DB: db,
    COOKIE_SECRET: "synthetic-browser-cookie-secret",
    IDP_ORIGIN: IDP,
    USER_ORIGIN: USER,
    ADMIN_ORIGIN: "https://admin.0g0.xyz",
    DISCORD_LOGIN_ENABLED: "true",
    STEAM_LOGIN_ENABLED: "true",
    DISCORD_CLIENT_ID: "111111111111111111",
    DISCORD_CLIENT_SECRET: "synthetic-discord-secret",
  } as IdpEnv;
  const idp = new Hono<{ Bindings: IdpEnv; Variables: { user: TokenPayload } }>();
  idp.use("/auth/link-intent", async (c, next) => {
    // Service authentication boundary is synthetic; protocol token issuing is real.
    assert.equal(c.req.header("Authorization"), "Bearer mock-access-token");
    c.set("user", { sub: "synthetic-user" } as TokenPayload);
    await next();
  });
  idp.post("/auth/link-intent", handleLinkIntent);
  idp.get("/auth/login", handleLogin);
  idp.post("/auth/login", handleLogin);
  const bffEnv = {
    IDP_ORIGIN: IDP,
    SELF_ORIGIN: USER,
    SESSION_SECRET: "test-secret",
    IDP: { fetch: (request: Request) => idp.fetch(request, idpEnv) },
  } as BffEnv;
  const bff = new Hono<{ Bindings: BffEnv }>();
  bff.use("/auth/link", bffCsrfMiddleware);
  bff.route("/auth", authRoutes);
  const sessionCookie = await makeSessionCookie({ userId: "synthetic-user" });
  let browser: any;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.SOCIAL_LOGIN_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.SOCIAL_LOGIN_CHROMIUM_EXECUTABLE }
        : {}),
    });
  } catch (error) {
    report.status = "browser-launch-failed";
    await writeFile(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2));
    sqlite.close();
    throw error;
  }
  const originalFetch = globalThis.fetch;
  // Application code must never reach an external endpoint either.
  globalThis.fetch = async () => {
    throw new Error("Unintercepted application network request");
  };

  async function generatedForm(provider: string) {
    const response = await bff.request(
      `${USER}/auth/link`,
      {
        method: "POST",
        headers: {
          Origin: USER,
          Cookie: `__Host-user-session=${sessionCookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ provider }),
      },
      bffEnv,
    );
    assert.equal(response.status, 200);
    return response;
  }

  try {
    for (const provider of ["discord", "steam"]) {
      for (const scenario of [
        "success",
        "manual-no-js",
        "evil-origin",
        "null-origin",
        "get-transplant",
      ]) {
        const successful = scenario === "success" || scenario === "manual-no-js";
        const context: any = await browser.newContext({
          // Playwright 1.57.0 browserContext.js:128-131 implements "block"
          // by reading navigator.serviceWorker without handling SecurityError.
          // Opaque-origin documents throw on that getter before app code runs.
          serviceWorkers: "allow",
          javaScriptEnabled: scenario !== "manual-no-js",
        });
        // Fresh contexts contain no workers. Install an equivalent registration
        // blocker before any page, but tolerate only the opaque-origin getter's
        // SecurityError. Application pageerrors are still all fatal below.
        await context.addInitScript(() => {
          let container: ServiceWorkerContainer | undefined;
          try {
            container = navigator.serviceWorker;
          } catch (error) {
            if (error instanceof DOMException && error.name === "SecurityError") return;
            throw error;
          }
          if (container) {
            Object.defineProperty(container, "register", {
              configurable: false,
              writable: false,
              value: async () => {
                throw new Error("Synthetic smoke blocks service worker registration");
              },
            });
          }
        });
        const page = await context.newPage();
        const errors: string[] = [];
        let stage = "browser fixture setup";
        let providerVisits = 0;
        let idpPosts = 0;
        let finalStatus: number | undefined;
        let postedOrigin: string | undefined;
        let copiedHtml = "";
        let transplantedQuery = "";
        const capturedCookies: string[] = [];
        page.on("pageerror", (error: Error) => errors.push(safeDiagnostic(error)));
        await context.addCookies([
          {
            name: "__Host-user-session",
            value: sessionCookie,
            url: USER,
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
        if (!successful) {
          copiedHtml = await (await generatedForm(provider)).text();
          const fields = [...copiedHtml.matchAll(/name="([^"]+)" value="([^"]*)"/g)];
          assert.equal(fields.length, 4);
          transplantedQuery = new URLSearchParams(
            fields.map(([, key, value]) => [key, value]),
          ).toString();
        }
        await context.route("**/*", async (route: any) => {
          const request = route.request();
          const url = new URL(request.url());
          try {
            if (successful) {
              assert.equal(
                url.searchParams.has("link_token"),
                false,
                "Intent must never enter browser URLs",
              );
            }
            if (["https://discord.com", "https://steamcommunity.com"].includes(url.origin)) {
              assert.ok(successful, "Attack must not navigate to provider");
              assert.equal(
                url.origin,
                provider === "discord" ? "https://discord.com" : "https://steamcommunity.com",
              );
              providerVisits++;
              await route.fulfill({
                contentType: "text/html",
                body: "<h1>Synthetic provider reached</h1>",
              });
              return;
            }
            if (url.origin === USER && url.pathname === "/fixture") {
              await route.fulfill({
                contentType: "text/html",
                body: `<form method="post" action="/auth/link"><input name="provider" value="${provider}"><button>Start synthetic link</button></form>`,
              });
              return;
            }
            if (url.origin === EVIL && url.pathname === "/fixture") {
              // A top-level CSP sandbox yields Origin:null for the real form POST,
              // without permanently sandboxing the IdP JSON error document. An
              // iframe sandbox also sandboxes Chromium's JSON viewer, whose own
              // storage access can throw unrelated opaque-origin SecurityErrors.
              await route.fulfill({
                contentType: "text/html",
                headers:
                  scenario === "null-origin"
                    ? { "Content-Security-Policy": "sandbox allow-scripts allow-forms" }
                    : {},
                body: copiedHtml,
              });
              return;
            }
            assert.ok(
              (url.origin === USER && url.pathname === "/auth/link") ||
                (url.origin === IDP && url.pathname === "/auth/login"),
              "Unexpected network destination blocked",
            );
            const headers = await request.allHeaders();
            if (url.origin === IDP && request.method() === "POST") {
              idpPosts++;
              postedOrigin = headers.origin;
              const fields = new URLSearchParams(request.postData() ?? "");
              assert.deepEqual([...fields.keys()].sort(), [
                "link_token",
                "provider",
                "redirect_to",
                "state",
              ]);
              assert.equal(fields.get("provider"), provider);
              assert.equal(fields.get("redirect_to"), `${USER}/auth/callback`);
              assert.ok(fields.get("link_token"));
            }
            const input = new Request(request.url(), {
              method: request.method(),
              headers,
              ...(request.method() === "POST" ? { body: request.postData() } : {}),
            });
            const response =
              url.origin === USER ? await bff.fetch(input, bffEnv) : await idp.fetch(input, idpEnv);
            const outgoing = Object.fromEntries(response.headers);
            const cookies = response.headers.getSetCookie();
            if (cookies.length) {
              capturedCookies.push(...cookies);
              outgoing["set-cookie"] = cookies.join("\n");
            }
            if (url.origin === USER) {
              assert.equal(response.headers.get("Cache-Control"), "no-store");
              assert.equal(response.headers.get("Referrer-Policy"), "origin");
              const policy = response.headers.get("Content-Security-Policy") ?? "";
              assert.match(policy, /script-src 'nonce-[A-Za-z0-9_-]+'/);
              assert.ok(policy.includes(`form-action ${IDP};`));
              assert.ok(policy.includes("frame-ancestors 'none'"));
            }
            if (url.origin === IDP) {
              finalStatus = response.status;
              if (successful) {
                assert.equal(
                  response.status,
                  200,
                  "POST success must render navigation HTML, not a form-action-blocked 302",
                );
                assert.equal(response.headers.has("Location"), false);
              }
            }
            await route.fulfill({
              status: response.status,
              headers: outgoing,
              body: await response.text(),
            });
          } catch (error) {
            errors.push(`Intercepted request: ${safeDiagnostic(error)}`);
            await route.abort("blockedbyclient");
          }
        });
        try {
          if (successful) {
            await page.goto(`${USER}/fixture`);
            stage = "BFF POST handoff";
            await page.getByRole("button", { name: "Start synthetic link" }).click();
            if (scenario === "manual-no-js") {
              await page.getByRole("button", { name: "連携を続ける" }).click();
              await page.locator("#provider-continue").click();
            }
            stage = "provider navigation under CSP";
            await page.waitForURL(
              provider === "discord" ? "https://discord.com/**" : "https://steamcommunity.com/**",
              { timeout: 15000 },
            );
            stage = "Origin, form and cookie assertions";
            assert.equal(providerVisits, 1);
            assert.equal(idpPosts, 1);
            assert.equal(postedOrigin, USER, "Browser must send exact user Origin");
            assert.ok(
              capturedCookies.length >= 3,
              "BFF state and IdP state/PKCE cookies are issued",
            );
            for (const cookie of capturedCookies) {
              assert.match(cookie, /; Secure/i);
              assert.match(cookie, /; HttpOnly/i);
              assert.match(cookie, /; SameSite=Lax/i);
            }
            const cookies: { secure: boolean; httpOnly: boolean; sameSite: string }[] =
              await context.cookies([USER, IDP]);
            for (const cookie of cookies) {
              assert.equal(cookie.secure, true);
              assert.equal(cookie.httpOnly, true);
              assert.equal(cookie.sameSite, "Lax");
            }
            assert.ok(
              cookies.filter(
                (cookie: any) => cookie.name.includes("oauth") || cookie.name.includes("pkce"),
              ).length >= 3,
            );
          } else {
            if (scenario === "get-transplant")
              await page.goto(`${IDP}/auth/login?${transplantedQuery}`);
            else await page.goto(`${EVIL}/fixture`);
            stage = "IdP attack rejection";
            for (let attempt = 0; finalStatus === undefined && attempt < 100; attempt++) {
              await page.waitForTimeout(50);
            }
            assert.equal(finalStatus, 400);
            assert.equal(providerVisits, 0);
            assert.equal(
              postedOrigin,
              scenario === "evil-origin" ? EVIL : scenario === "null-origin" ? "null" : undefined,
            );
          }
          assert.deepEqual(errors, []);
          report.cases.push({
            provider,
            scenario,
            status: "passed",
            finalStatus: finalStatus ?? null,
            postedOrigin: postedOrigin ?? null,
            idpPosts,
            providerVisits,
          });
        } catch (error) {
          report.cases.push({
            provider,
            scenario,
            status: "failed",
            stage,
            errors,
            failure: safeDiagnostic(error),
            finalStatus: finalStatus ?? null,
            postedOrigin: postedOrigin ?? null,
            idpPosts,
            providerVisits,
          });
          // Screenshot contains only synthetic fixtures, never cookies/token reports.
          await page
            .screenshot({ path: path.join(reportDir, `${provider}-${scenario}-failure.png`) })
            .catch(() => {});
        } finally {
          await context.close();
        }
      }
    }
    report.status = report.cases.some((item) => item.status === "failed") ? "failed" : "passed";
    if (report.status === "failed") process.exitCode = 1;
  } catch {
    report.status = "failed";
    process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
    await browser.close();
    sqlite.close();
    await writeFile(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
}
void main().catch((error: unknown) => {
  console.error(
    "Social login browser smoke setup failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
});
