// Temporary read-only diagnostic. Remove together with the lock-generation helper.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const timeout = setTimeout(() => {
  console.error("Override diagnostic exceeded 45 seconds");
  process.exit(1);
}, 45_000);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  assert.equal(process.argv.length, 3, "Expected one npm binary path");
  const npmBinary = realpathSync(process.argv[2]);
  // Official Vite+ JS package-manager layout puts npm-cli.js beside its bin shim.
  const npmEntry = realpathSync(path.join(path.dirname(npmBinary), "npm-cli.js"));
  const npmRoot = path.dirname(path.dirname(npmEntry));
  const npmPackage = readJson(path.join(npmRoot, "package.json"));
  assert.equal(npmPackage.name, "npm");
  assert.equal(npmPackage.version, "11.21.2");
  const npmRequire = createRequire(npmEntry);
  const arboristEntry = npmRequire.resolve("@npmcli/arborist");
  const arboristManifest = npmRequire.resolve("@npmcli/arborist/package.json");
  assert(arboristEntry.startsWith(npmRoot + path.sep));
  assert(arboristManifest.startsWith(npmRoot + path.sep));
  const arboristPackage = readJson(arboristManifest);
  const manifestBytes = readFileSync("package.json");
  const lockBytes = readFileSync("package-lock.json");
  const manifest = JSON.parse(manifestBytes);
  const selectedOverrides = Object.fromEntries(
    Object.entries(manifest.overrides ?? {}).filter(([key]) =>
      /^(undici|miniflare|postcss|nanoid|tinypool|semver|tslib)(@|$)/.test(key),
    ),
  );
  const Arborist = npmRequire("@npmcli/arborist");
  const tree = await new Arborist({
    path: process.cwd(),
    offline: true,
    ignoreScripts: true,
    audit: false,
    fund: false,
  }).loadVirtual();
  assert.equal(tree.meta.filename, path.resolve("package-lock.json"));
  const rule = (value) =>
    value
      ? {
          key: value.key ?? null,
          value: value.value ?? null,
        }
      : null;
  const selected = [...tree.inventory.values()].filter(
    (node) => node.isProjectRoot || node.isWorkspace || ["miniflare", "undici"].includes(node.name),
  );
  assert(selected.length <= 32, "Diagnostic node count limit");
  const nodes = selected.map((node) => {
    const incoming = [...node.edgesIn];
    assert(incoming.length <= 32, "Diagnostic parent count limit");
    return {
      name: node.name,
      version: node.version,
      location: node.location,
      projectRoot: node.isProjectRoot,
      workspace: node.isWorkspace,
      overridden: node.overridden,
      override: rule(node.overrides),
      incoming: incoming.map((edge) => ({
        parentName: edge.from.name,
        parentLocation: edge.from.location,
        name: edge.name,
        rawSpec: edge.rawSpec,
        effectiveSpec: edge.spec,
        specChangedByOverride: edge.spec !== edge.rawSpec,
        override: rule(edge.overrides),
      })),
    };
  });
  assert.equal(digest(readFileSync("package.json")), digest(manifestBytes));
  assert.equal(digest(readFileSync("package-lock.json")), digest(lockBytes));
  const output = JSON.stringify(
    {
      npmBinary,
      npmEntry,
      npmVersion: npmPackage.version,
      arboristEntry,
      arboristVersion: arboristPackage.version,
      cwd: process.cwd(),
      rootManifestSha256: digest(manifestBytes),
      lockSha256: digest(lockBytes),
      selectedOverrides,
      nodes,
    },
    null,
    2,
  );
  assert(Buffer.byteLength(output) <= 131_072, "Diagnostic output limit");
  console.log(output);
} catch {
  console.error(
    "Read-only override diagnostic failed; no configuration or environment dump emitted",
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
