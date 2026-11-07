import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "../workers/id/src/index";
import { INTERNAL_OPENAPI } from "../workers/id/src/routes/openapi/internal-spec";
import {
  checkIdpMetricsDocs,
  compareIdpMetricsCoverage,
  runIdpMetricsDocsCli,
} from "./check-idp-metrics-docs";

const routes = [{ method: "GET", path: "/api/metrics" }];
afterEach(() => {
  vi.restoreAllMocks();
});

describe("IdP metrics method/path coverage", () => {
  it("compares the real mounted app surface with the complete internal specification", () => {
    expect(checkIdpMetricsDocs()).toEqual([]);
    const actual = new Set(
      app.routes
        .filter(
          ({ method, path }) =>
            method !== "ALL" && (path === "/api/metrics" || path.startsWith("/api/metrics/")),
        )
        .map(({ method, path }) => `${method} ${path}`),
    );
    expect(actual.size).toBe(11);
  });

  it("detects a missing operation even when generated Markdown would still match its source", () => {
    const paths: Record<string, unknown> = { ...INTERNAL_OPENAPI.paths };
    delete paths["/api/metrics/suspicious-logins"];
    expect(compareIdpMetricsCoverage(app.routes, paths)).toEqual([
      "Missing metrics specification: GET /api/metrics/suspicious-logins",
    ]);
  });

  it("detects added, removed, changed-method and similarly named paths bidirectionally", () => {
    expect(
      compareIdpMetricsCoverage([...routes, { method: "POST", path: "/api/metrics/new" }], {
        "/api/metrics": { post: {} },
        "/api/metrics/removed": { get: {} },
        "/api/metrics-other": { get: {} },
      }),
    ).toEqual([
      "Missing metrics specification: GET /api/metrics",
      "Missing metrics specification: POST /api/metrics/new",
      "No registered metrics endpoint: GET /api/metrics/removed",
      "No registered metrics endpoint: POST /api/metrics",
    ]);
  });

  it("ignores unrelated routes, ALL middleware and duplicate handler registrations", () => {
    expect(
      compareIdpMetricsCoverage(
        [
          ...routes,
          ...routes,
          { method: "ALL", path: "/api/metrics/*" },
          { method: "GET", path: "/api/metrics-other" },
        ],
        { "/api/metrics": { get: {}, description: "path metadata" }, "/api/other": { get: {} } },
      ),
    ).toEqual([]);
  });

  it("fails on empty inventories and malformed documented path/operation objects", () => {
    expect(() => compareIdpMetricsCoverage([], {})).toThrow("No method-specific");
    expect(() => compareIdpMetricsCoverage(routes, { "/api/metrics": null })).toThrow("path item");
    expect(() => compareIdpMetricsCoverage(routes, { "/api/metrics": { get: null } })).toThrow(
      "operation",
    );
    expect(() => compareIdpMetricsCoverage(routes, { "/api/metrics": { get: [] } })).toThrow(
      "operation",
    );
  });

  it("requires explicit read-only CLI mode and returns success for the current source", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runIdpMetricsDocsCli([])).toBe(2);
    expect(runIdpMetricsDocsCli(["--generate"])).toBe(2);
    expect(runIdpMetricsDocsCli(["--check", "extra"])).toBe(2);
    expect(runIdpMetricsDocsCli(["--check"])).toBe(0);
  });

  it("runs the actual CLI without changing either generated reference or source", () => {
    const root = join(__dirname, "..");
    const files = [
      "docs/generated/id-internal.md",
      "docs/generated/id-external.md",
      "workers/id/src/routes/openapi/internal-spec.ts",
    ];
    const snapshot = (): unknown =>
      files.map((file) => {
        const path = join(root, file);
        return [file, statSync(path).mtimeMs, readFileSync(path, "utf8")];
      });
    const before = snapshot();
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/check-idp-metrics-docs.ts", "--check"],
      { cwd: root, encoding: "utf8", timeout: 30000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("11 endpoints; read-only check");
    expect(snapshot()).toEqual(before);
  });
});
