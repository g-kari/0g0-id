import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "../workers/id/src/index";
import { EXTERNAL_OPENAPI } from "../workers/id/src/routes/openapi/external-spec";
import { INTERNAL_OPENAPI } from "../workers/id/src/routes/openapi/internal-spec";
import {
  canonicalEndpoint,
  checkIdpApiDocs,
  compareIdpApiDocs,
  markdownInventory,
  openApiOperations,
  routeInventory,
  runIdpApiDocsCli,
} from "./check-idp-api-docs";

const routes = [{ method: "GET", path: "/api/health" }];
const internal = { "/api/health": { get: { responses: { "200": { description: "ok" } } } } };
const external = {};
const markdown = "| Method | Path |\n| --- | --- |\n| GET | `/api/health` |\n";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IdP API inventory", () => {
  it("matches mounted routes, both OpenAPI documents, and docs/api-id.md", () => {
    expect(checkIdpApiDocs()).toEqual([]);
    const actual = routeInventory(app.routes);
    expect(actual.length).toBeGreaterThan(68);
    expect(openApiOperations(INTERNAL_OPENAPI.paths)).toEqual(actual);
    expect(new Set(actual)).toEqual(new Set(openApiOperations(INTERNAL_OPENAPI.paths)));
    for (const key of openApiOperations(EXTERNAL_OPENAPI.paths)) expect(actual).toContain(key);
    expect(actual).toContain("GET /auth/authorize");
    expect(actual).toContain("POST /auth/dbsc/bind");
    expect(actual).toContain("DELETE /api/users/me/tokens/others");
    expect(actual).toContain("GET /docs/openapi.json");
  });

  it("treats Hono and OpenAPI parameter syntax as the same operation", () => {
    expect(canonicalEndpoint("GET", "/api/users/{id}/tokens/{tokenId}")).toBe(
      "GET /api/users/:id/tokens/:tokenId",
    );
    expect(
      compareIdpApiDocs(
        [{ method: "GET", path: "/api/users/:id" }],
        { "/api/users/{id}": { get: {}, parameters: [] } },
        { "/api/users/{id}": { get: {} } },
        "| Method | Path |\n| --- | --- |\n| GET | `/api/users/:id` |\n",
      ),
    ).toEqual([]);
  });

  it("reports routes, specifications, and handwritten rows that diverge", () => {
    expect(
      compareIdpApiDocs(
        [...routes, { method: "POST", path: "/api/register" }],
        {
          ...internal,
          "/api/removed": { get: {} },
          "/docs": { summary: "metadata", get: {} },
        },
        { "/api/external-only": { post: {} }, "/api/health": { get: {} } },
        "| Method | Path |\n| --- | --- |\n| GET | `/api/health` |\n| DELETE | `/api/old` |\n",
      ),
    ).toEqual([
      "Missing internal specification: POST /api/register",
      "No registered endpoint for internal specification: GET /api/removed",
      "No registered endpoint for internal specification: GET /docs",
      "No registered endpoint for external specification: POST /api/external-only",
      "External specification is absent from the internal specification: POST /api/external-only",
      "Missing docs/api-id.md row: POST /api/register",
      "No registered endpoint for docs/api-id.md: DELETE /api/old",
    ]);
  });

  it("ignores ALL middleware, vendor extensions, and duplicate handlers", () => {
    expect(
      compareIdpApiDocs(
        [...routes, ...routes, { method: "ALL", path: "/api/health/*" }],
        { "/api/health": { get: {}, "x-internal": true } },
        {},
        markdown,
      ),
    ).toEqual([]);
  });

  it("rejects an empty route list and malformed specification or markdown", () => {
    expect(() => compareIdpApiDocs([], internal, external, markdown)).toThrow("No method-specific");
    expect(() => compareIdpApiDocs(routes, { "/api/health": null }, external, markdown)).toThrow(
      "path item",
    );
    expect(() =>
      compareIdpApiDocs(routes, { "/api/health": { get: null } }, external, markdown),
    ).toThrow("operation");
    expect(() =>
      compareIdpApiDocs(routes, { "/api/health": { traceX: {} } }, external, markdown),
    ).toThrow("method");
    expect(() =>
      openApiOperations({
        "/api/health": { get: {} },
        "/api/health/{id}": {},
      }),
    ).not.toThrow();
    expect(() =>
      markdownInventory(
        "| Method | Path |\n| --- | --- |\n| GET | `/api/users/{id}` |\n| GET | `/api/users/:id` |\n",
      ),
    ).toThrow("Duplicate documented endpoint");
  });

  it("requires explicit read-only CLI mode and returns success for the current source", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runIdpApiDocsCli([])).toBe(2);
    expect(runIdpApiDocsCli(["--generate"])).toBe(2);
    expect(runIdpApiDocsCli(["--check", "extra"])).toBe(2);
    expect(runIdpApiDocsCli(["--check"])).toBe(0);
  });

  it("runs the actual CLI without rewriting docs or specifications", () => {
    const root = join(__dirname, "..");
    const files = [
      "docs/api-id.md",
      "docs/generated/id-internal.md",
      "docs/generated/id-external.md",
      "workers/id/src/routes/openapi/internal-spec.ts",
      "workers/id/src/routes/openapi/route-inventory-spec.ts",
    ];
    const snapshot = (): unknown =>
      files.map((file) => {
        const path = join(root, file);
        return [file, statSync(path).mtimeMs, readFileSync(path, "utf8")];
      });
    const before = snapshot();
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/check-idp-api-docs.ts", "--check"],
      { cwd: root, encoding: "utf8", timeout: 30000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("read-only check");
    expect(snapshot()).toEqual(before);
  });
});
