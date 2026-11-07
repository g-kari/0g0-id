import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  BFF_DOCUMENTS,
  checkBffApiDocs,
  compareEndpointCoverage,
  documentedEndpoints,
  registeredEndpoints,
  runBffApiDocsCli,
} from "./check-bff-api-docs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const table = (rows: string): string =>
  `| Method | Path | Description |\n| --- | --- | --- |\n${rows}`;
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "bff-api-docs-test-"));
  roots.push(root);
  mkdirSync(join(root, "docs"));
  for (const file of BFF_DOCUMENTS) {
    writeFileSync(join(root, "docs", file), readFileSync(join(__dirname, "..", "docs", file)));
  }
  return root;
}
function snapshot(root: string): unknown {
  return readdirSync(join(root, "docs"))
    .sort()
    .map((file) => {
      const path = join(root, "docs", file);
      return [file, statSync(path).mtimeMs, readFileSync(path, "utf8")];
    });
}

describe("BFF API endpoint documentation coverage", () => {
  it("uses mounted Hono routes, including factories, and deduplicates multiple handlers", () => {
    const child = new Hono();
    child.use("*", async (_c, next) => {
      await next();
    });
    child.get(
      "/",
      async (_c, next) => {
        await next();
      },
      (c) => c.text("unused"),
    );
    child.post("/:id", (c) => c.text("unused"));
    const app = new Hono();
    app.route("/api/items", child);
    app.get("*", (c) => c.text("unused"));
    expect(registeredEndpoints(app.routes)).toEqual([
      "GET /*",
      "GET /api/items",
      "POST /api/items/:id",
    ]);
    expect(
      compareEndpointCoverage(
        app.routes,
        table(
          "| GET | `*` | fallback |\n| GET | `/api/items` | list |\n| POST | `/api/items/:id` | item |",
        ),
      ),
    ).toEqual([]);
  });

  it("reports new, deleted, and changed-method endpoints separately in stable order", () => {
    expect(
      compareEndpointCoverage(
        [
          { method: "POST", path: "/auth/dbsc/start" },
          { method: "GET", path: "/api/new" },
        ],
        table("| GET | `/auth/dbsc/start` | old method |\n| DELETE | `/api/removed` | stale |"),
      ),
    ).toEqual([
      "Missing documentation: GET /api/new",
      "Missing documentation: POST /auth/dbsc/start",
      "No registered endpoint: DELETE /api/removed",
      "No registered endpoint: GET /auth/dbsc/start",
    ]);
  });

  it("parses only Method/Path tables, not response tables, prose, forwarding targets, or fenced examples", () => {
    const markdown = [
      "GET /api/not-a-table",
      "```md",
      table("| GET | `/api/example` | example |"),
      "```",
      "~~~~md",
      table("| GET | `/api/example-too` | example |"),
      "~~~~",
      "| HTTP | code | condition |",
      "| GET | `INVALID` | ignored |",
      "",
      table("| POST | `/auth/dbsc/refresh` | `/idp/target` |"),
      "",
      table("| GET | `/api/items` | contains an escaped \\| in prose |"),
    ].join("\n");
    expect(documentedEndpoints(markdown)).toEqual(["GET /api/items", "POST /auth/dbsc/refresh"]);
  });

  it.each([
    [table("| GET | /api/items | missing inline code |"), /inline-code/],
    [table("| get | `/api/items` | lowercase method |"), /malformed/],
    [table("| FETCH | `/api/items` | unsupported method |"), /Unsupported/],
    [table("| GET | `api/items` | invalid path |"), /Invalid/],
    [table("| GET | `/api/items` | one |\n| GET | `/api/items` | duplicate |"), /duplicate/],
    [table("| GET | `*` | one |\n| GET | `/*` | duplicate alias |"), /duplicate/],
    ["| Method | Path | Description |\n| GET | `/api/items` | no delimiter |", /delimiter/],
    ["| Method | Path | Description |\n| --- | `/api/items` | malformed delimiter |", /delimiter/],
    [table("| --- | `/api/items` | malformed endpoint |"), /malformed/],
    ["No endpoints", /No Method/],
  ])(
    "fails malformed or duplicate endpoint tables instead of silently omitting them",
    (markdown, error) => {
      expect(() => documentedEndpoints(markdown)).toThrow(error);
    },
  );

  it("rejects empty route inventories and unsupported method registrations", () => {
    expect(() => compareEndpointCoverage([], table("| GET | `/api/a` | route |"))).toThrow(
      /No method/,
    );
    expect(() => registeredEndpoints([{ method: "FETCH", path: "/api/a" }])).toThrow(/Unsupported/);
  });

  it("covers real user/admin routes and DBSC registration/refresh without invoking handlers", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Network forbidden");
    });
    expect(checkBffApiDocs()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    for (const file of BFF_DOCUMENTS) {
      const keys = documentedEndpoints(readFileSync(join(__dirname, "..", "docs", file), "utf8"));
      expect(keys).toContain("POST /auth/dbsc/start");
      expect(keys).toContain("POST /auth/dbsc/refresh");
      expect(keys).toContain("GET /api/*");
      expect(keys).toContain("GET /*");
    }
  });

  it("is read-only on matching, drifted, malformed, and missing documentation", () => {
    const root = fixture();
    const initial = snapshot(root);
    expect(checkBffApiDocs(root)).toEqual([]);
    expect(snapshot(root)).toEqual(initial);
    const user = join(root, "docs", BFF_DOCUMENTS[0]);
    writeFileSync(
      user,
      readFileSync(user, "utf8").replace(
        /(\| POST\s+\| )`\/auth\/dbsc\/start`/,
        "$1`/auth/dbsc/missing`",
      ),
    );
    const changed = snapshot(root);
    expect(checkBffApiDocs(root)).toEqual([
      "docs/api-user.md: Missing documentation: POST /auth/dbsc/start",
      "docs/api-user.md: No registered endpoint: POST /auth/dbsc/missing",
    ]);
    expect(snapshot(root)).toEqual(changed);
    writeFileSync(user, "No endpoint table");
    const malformed = snapshot(root);
    expect(checkBffApiDocs(root)[0]).toMatch(/No Method/);
    expect(snapshot(root)).toEqual(malformed);
    rmSync(user);
    const missing = snapshot(root);
    expect(checkBffApiDocs(root)[0]).toMatch(/ENOENT/);
    expect(snapshot(root)).toEqual(missing);
  });

  it("accepts only the read-only check command", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runBffApiDocsCli([])).toBe(2);
    expect(runBffApiDocsCli(["--generate"])).toBe(2);
    expect(runBffApiDocsCli(["--check", "--output", "/tmp/elsewhere"])).toBe(2);
    expect(runBffApiDocsCli(["--check"])).toBe(0);
  });

  it("the real CLI exits nonzero on table drift and missing docs without writing", () => {
    const root = fixture();
    mkdirSync(join(root, "scripts"));
    const script = join(root, "scripts", "check-bff-api-docs.ts");
    writeFileSync(script, readFileSync(join(__dirname, "check-bff-api-docs.ts")));
    symlinkSync(join(__dirname, "..", "workers"), join(root, "workers"));
    const guard = join(root, "no-network.cjs");
    writeFileSync(guard, "globalThis.fetch = () => { throw new Error('Network forbidden'); };\n");
    const run = (): ReturnType<typeof spawnSync> =>
      spawnSync(
        process.execPath,
        ["--require", guard, "--import", require.resolve("tsx"), script, "--check"],
        { cwd: tmpdir(), encoding: "utf8", timeout: 10_000 },
      );
    const current = snapshot(root);
    const matching = run();
    expect(matching.status, String(matching.stderr)).toBe(0);
    expect(snapshot(root)).toEqual(current);
    const admin = join(root, "docs", "api-admin.md");
    writeFileSync(
      admin,
      readFileSync(admin, "utf8").replace(
        /(\| GET\s+\| )`\/api\/metrics\/dbsc-bindings`/,
        "$1`/api/metrics/missing`",
      ),
    );
    const changed = snapshot(root);
    const drifted = run();
    expect(drifted.status, String(drifted.stderr)).toBe(1);
    expect(String(drifted.stderr)).toContain(
      "Missing documentation: GET /api/metrics/dbsc-bindings",
    );
    expect(String(drifted.stderr)).toContain("No registered endpoint: GET /api/metrics/missing");
    expect(snapshot(root)).toEqual(changed);
    rmSync(admin);
    const missing = snapshot(root);
    expect(run().status).toBe(1);
    expect(snapshot(root)).toEqual(missing);
  });

  it("loads the actual apps in a fresh process with fetch forbidden and returns zero", () => {
    const script = join(__dirname, "check-bff-api-docs.ts");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        "-e",
        `globalThis.fetch = () => { throw new Error('Network forbidden'); }; process.exitCode = require(${JSON.stringify(script)}).runBffApiDocsCli(['--check']);`,
      ],
      { cwd: tmpdir(), encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("BFF API endpoint tables are current");
    expect(result.stdout).toContain("read-only check");
  });
});
