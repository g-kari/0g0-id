import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Run from the repository root after clean install of root and both frontends.
const root = process.cwd();
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const rootRequire = createRequire(join(root, "package.json"));
const [major, minor] = process.versions.node.split(".").map(Number);
assert(major === 22 && minor >= 19, `Expected supported Node 22.19+, got ${process.version}`);

assert.equal(read(join(root, "package.json")).devDependencies.typescript, "6.0.3");
const rootTs = rootRequire("typescript");
assert.equal(rootTs.version, "6.0.3");
assert.equal(typeof rootTs.createProgram, "function");
const vpRequire = createRequire(rootRequire.resolve("vite-plus/package.json"));
const corePackagePath = vpRequire.resolve("vite/package.json");
const corePackage = read(corePackagePath);
assert.equal(corePackage.name, "@voidzero-dev/vite-plus-core");
assert.equal(corePackage.version, read(rootRequire.resolve("vite-plus/package.json")).version);
const coreRequire = createRequire(corePackagePath);
const vitestPackagePath = vpRequire.resolve("vitest/package.json");
assert.equal(read(vitestPackagePath).version, read(join(root, "package.json")).overrides.vitest);
console.log(`Vite+ core: ${realpathSync(corePackagePath)} (${corePackage.version})`);
console.log(`Vite+ Vitest: ${realpathSync(vitestPackagePath)}`);
const peerVitePath = rootRequire.resolve("vite/package.json");
console.log(`Root Vite peer: ${realpathSync(peerVitePath)} (${read(peerVitePath).version})`);
const coreTs = coreRequire("typescript");
assert.equal(coreTs.version, "6.0.3");
assert.equal(typeof coreTs.createProgram, "function");
console.log(`Root and Vite+ compiler API resolve TypeScript ${coreTs.version}`);

for (const worker of ["admin", "user"]) {
  const frontend = join(root, "workers", worker, "frontend");
  const localRequire = createRequire(join(frontend, "package.json"));
  assert.match(
    read(join(frontend, "package.json")).devDependencies.typescript,
    /^\^?6\./,
    "frontend typescript range must stay on the 6.x line",
  );
  const lockVersion =
    read(join(frontend, "package-lock.json")).packages["node_modules/typescript"].version;
  assert.match(lockVersion, /^6\./, "frontend lockfile typescript must stay on the 6.x line");
  const installedVersion = localRequire("typescript").version;
  assert.match(installedVersion, /^6\./, "frontend installed typescript must stay on the 6.x line");
  assert.equal(typeof localRequire("typescript").createProgram, "function");
  console.log(`${worker} frontend remains on TypeScript ${installedVersion}`);
}

const workspaces = [
  "packages/shared",
  "workers/admin",
  "workers/id",
  "workers/mcp",
  "workers/user",
];
for (const workspace of workspaces) {
  const cwd = join(root, workspace);
  const localRequire = createRequire(join(cwd, "package.json"));
  const localVpRequire = createRequire(localRequire.resolve("vite-plus/package.json"));
  assert.equal(
    realpathSync(localVpRequire.resolve("vite/package.json")),
    realpathSync(corePackagePath),
  );
  assert.equal(
    realpathSync(localVpRequire.resolve("vitest/package.json")),
    realpathSync(vitestPackagePath),
  );
  const packagePath = localRequire.resolve("typescript/package.json");
  assert.equal(
    realpathSync(packagePath),
    realpathSync(join(cwd, "node_modules/typescript/package.json")),
  );
  const compilerPackage = read(packagePath);
  assert.equal(compilerPackage.version, "7.0.2");
  assert.equal(read(join(cwd, "package.json")).devDependencies.typescript, "^7.0.2");
  const compiler = resolve(
    dirname(packagePath),
    typeof compilerPackage.bin === "string" ? compilerPackage.bin : compilerPackage.bin.tsc,
  );
  const version = spawnSync(process.execPath, [compiler, "--version"], { cwd, encoding: "utf8" });
  assert.equal(
    version.status,
    0,
    `${workspace}: version failed: ${version.stderr || version.error || version.signal}`,
  );
  assert.match(version.stdout.trim(), /^Version 7\.0\.2$/);
  console.log(`${workspace}: ${version.stdout.trim()}`);
  const checked = spawnSync(
    process.execPath,
    [compiler, "--noEmit", "--project", join(cwd, "tsconfig.json")],
    { cwd, stdio: "inherit" },
  );
  assert.equal(
    checked.status,
    0,
    `${workspace}: tsc --noEmit failed (${checked.error || checked.signal || checked.status})`,
  );
  console.log(`${workspace}: TypeScript 7.0.2 --noEmit passed`);
}
