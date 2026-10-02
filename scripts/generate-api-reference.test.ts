import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  linkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REFERENCE_FILES,
  renderApiReferences,
  runApiReferenceCli,
  syncApiReferences,
} from "./generate-api-reference";
import type { OpenApiSpec } from "../workers/id/src/routes/openapi/markdown";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "api-reference-test-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function snapshot(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isDirectory()
    ? {
        mtime: stat.mtimeMs,
        children: readdirSync(path)
          .sort()
          .map((name) => [name, snapshot(join(path, name))]),
      }
    : { mtime: stat.mtimeMs, size: stat.size, data: readFileSync(path, "utf8") };
}
const synthetic: OpenApiSpec = {
  info: { title: "Synthetic" },
  paths: { "/example": { get: { responses: { "200": { description: "OK" } } } } },
};

describe("offline API reference generator", () => {
  it("generates deterministic bytes and check writes nothing, including on missing/manual-edited outputs", () => {
    const path = root();
    const references = renderApiReferences(synthetic, synthetic);
    const empty = snapshot(path);
    expect(syncApiReferences("check", path, references)).toHaveLength(2);
    expect(snapshot(path)).toEqual(empty);
    expect(syncApiReferences("generate", path, references)).toHaveLength(2);
    const current = snapshot(path);
    expect(syncApiReferences("check", path, references)).toEqual([]);
    expect(syncApiReferences("generate", path, references)).toEqual([]);
    expect(snapshot(path)).toEqual(current);
    const output = join(path, "docs", "generated", REFERENCE_FILES[0]);
    writeFileSync(output, "manual edit\n");
    const modified = snapshot(path);
    expect(syncApiReferences("check", path, references)).toEqual([
      `docs/generated/${REFERENCE_FILES[0]}`,
    ]);
    expect(snapshot(path)).toEqual(modified);
    rmSync(output);
    const missing = snapshot(path);
    expect(syncApiReferences("check", path, references)).toHaveLength(1);
    expect(snapshot(path)).toEqual(missing);
    syncApiReferences("generate", path, references);
    expect(readFileSync(output, "utf8")).toBe(references[REFERENCE_FILES[0]]);
  });

  it("a spec change fails check until generation without touching handwritten docs", () => {
    const path = root();
    mkdirSync(join(path, "docs"));
    writeFileSync(join(path, "docs", "api-id.md"), "handwritten\n");
    syncApiReferences("generate", path, renderApiReferences(synthetic, synthetic));
    const changed = renderApiReferences({ ...synthetic, info: { title: "Changed" } }, synthetic);
    expect(syncApiReferences("check", path, changed)).toEqual(["docs/generated/id-internal.md"]);
    syncApiReferences("generate", path, changed);
    expect(syncApiReferences("check", path, changed)).toEqual([]);
    expect(readFileSync(join(path, "docs", "api-id.md"), "utf8")).toBe("handwritten\n");
  });

  it("validates both specs before allowing output and performs no network fetch", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Network forbidden");
    });
    expect(renderApiReferences()).toEqual(renderApiReferences());
    expect(fetch).not.toHaveBeenCalled();
    const malformed: OpenApiSpec = {
      ...synthetic,
      components: { schemas: { Missing: { $ref: "#/not-there" } } },
    };
    expect(() => renderApiReferences(synthetic, malformed)).toThrow(/Missing/);
  });

  it.each(["docs", "generated", "file"])("rejects symlink %s paths even in check mode", (kind) => {
    const path = root();
    const elsewhere = root();
    if (kind === "docs") symlinkSync(elsewhere, join(path, "docs"));
    else {
      mkdirSync(join(path, "docs", "generated"), { recursive: true });
      if (kind === "generated") {
        rmSync(join(path, "docs", "generated"), { recursive: true });
        symlinkSync(elsewhere, join(path, "docs", "generated"));
      } else {
        writeFileSync(join(elsewhere, "outside.md"), "outside");
        symlinkSync(
          join(elsewhere, "outside.md"),
          join(path, "docs", "generated", REFERENCE_FILES[0]),
        );
      }
    }
    for (const mode of ["generate", "check"] as const)
      expect(() =>
        syncApiReferences(mode, path, renderApiReferences(synthetic, synthetic)),
      ).toThrow(/Unsafe/);
  });

  it("rejects hardlinks and non-files before writing either output", () => {
    const path = root();
    const elsewhere = root();
    const output = join(path, "docs", "generated");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(elsewhere, "outside.md"), "outside");
    linkSync(join(elsewhere, "outside.md"), join(output, REFERENCE_FILES[1]));
    expect(() =>
      syncApiReferences("generate", path, renderApiReferences(synthetic, synthetic)),
    ).toThrow(/Unsafe/);
    expect(readFileSync(join(elsewhere, "outside.md"), "utf8")).toBe("outside");
    expect(readdirSync(output)).toEqual([REFERENCE_FILES[1]]);
    rmSync(join(output, REFERENCE_FILES[1]));
    mkdirSync(join(output, REFERENCE_FILES[1]));
    expect(() =>
      syncApiReferences("generate", path, renderApiReferences(synthetic, synthetic)),
    ).toThrow(/Unsafe/);
  });

  it("rejects unsupported flags and arbitrary output paths", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runApiReferenceCli([])).toBe(2);
    expect(runApiReferenceCli(["--check", "--output", "/tmp/elsewhere"])).toBe(2);
    expect(runApiReferenceCli(["--generate", "../api-id.md"])).toBe(2);
  });

  it("the real offline CLI fails drift/missing outputs and repairs them with generation", () => {
    const path = root();
    const scripts = join(path, "scripts");
    const sources = join(path, "workers", "id", "src", "routes", "openapi");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(sources, { recursive: true });
    writeFileSync(
      join(scripts, "generate-api-reference.ts"),
      readFileSync(join(__dirname, "generate-api-reference.ts")),
    );
    writeFileSync(
      join(sources, "markdown.ts"),
      readFileSync(join(__dirname, "../workers/id/src/routes/openapi/markdown.ts")),
    );
    const internal = join(sources, "internal-spec.ts");
    writeFileSync(internal, `export const INTERNAL_OPENAPI = ${JSON.stringify(synthetic)};`);
    writeFileSync(
      join(sources, "external-spec.ts"),
      `export const EXTERNAL_OPENAPI = ${JSON.stringify(synthetic)};`,
    );
    const run = (mode: string): number | null =>
      spawnSync(
        process.execPath,
        ["--import", require.resolve("tsx"), join(scripts, "generate-api-reference.ts"), mode],
        { cwd: tmpdir(), encoding: "utf8", timeout: 10_000 },
      ).status;
    expect(run("--check")).toBe(1);
    expect(run("--generate")).toBe(0);
    const current = snapshot(path);
    expect(run("--check")).toBe(0);
    expect(snapshot(path)).toEqual(current);
    writeFileSync(
      internal,
      `export const INTERNAL_OPENAPI = ${JSON.stringify({ ...synthetic, info: { title: "Updated synthetic source" } })};`,
    );
    const changed = snapshot(path);
    expect(run("--check")).toBe(1);
    expect(snapshot(path)).toEqual(changed);
    expect(run("--generate")).toBe(0);
    expect(run("--check")).toBe(0);
    writeFileSync(join(path, "docs", "generated", REFERENCE_FILES[0]), "manual edit");
    const edited = snapshot(path);
    expect(run("--check")).toBe(1);
    expect(snapshot(path)).toEqual(edited);
  });

  it("has structurally intact tables and exactly one heading per specified endpoint", () => {
    for (const document of Object.values(renderApiReferences())) {
      let columns: number | undefined;
      for (const line of document.split("\n")) {
        if (!line.startsWith("|")) {
          columns = undefined;
          continue;
        }
        const count = line.split("|").length;
        if (columns === undefined) columns = count;
        expect(count).toBe(columns);
      }
      const headings =
        document.match(/^### (?:GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS|TRACE) .+$/gm) ?? [];
      expect(new Set(headings).size).toBe(headings.length);
    }
  });
});
