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
const coreRequire = createRequire(vpRequire.resolve("@voidzero-dev/vite-plus-core/package.json"));
const coreTs = coreRequire("typescript");
assert.equal(coreTs.version, "6.0.3");
assert.equal(typeof coreTs.createProgram, "function");
console.log(`Root and Vite+ compiler API resolve TypeScript ${coreTs.version}`);

for (const worker of ["admin", "user"]) {
  const frontend = join(root, "workers", worker, "frontend");
  const localRequire = createRequire(join(frontend, "package.json"));
  assert.equal(read(join(frontend, "package.json")).devDependencies.typescript, "^6.0.2");
  assert.equal(
    read(join(frontend, "package-lock.json")).packages["node_modules/typescript"].version,
    "6.0.2",
  );
  assert.equal(localRequire("typescript").version, "6.0.2");
  assert.equal(typeof localRequire("typescript").createProgram, "function");
  console.log(`${worker} frontend remains on TypeScript 6.0.2`);
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
