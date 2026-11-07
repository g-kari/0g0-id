/** Inventory and startup guards, not a proof that bundled Undici is fixed. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export function assertCloudflareStartup(): void {
  const validNodeOptions = (process.env.NODE_OPTIONS?.trim() ?? "") === "";
  assert.ok(validNodeOptions, "Undeclared NODE_OPTIONS");
  // This is the declared CI launcher, also inherited by every Vite child.
  const validExecArgv =
    process.execArgv.length === 2 &&
    process.execArgv[0] === "--import" &&
    process.execArgv[1] === "tsx";
  assert.ok(validExecArgv, "Undeclared Node startup arguments");
}

export function checkCloudflareToolchain(repository: string): void {
  assertCloudflareStartup();
  const seen = new Set<string>();
  for (const worker of ["id", "user", "admin", "mcp"]) {
    const requireWorker = createRequire(path.join(repository, "workers", worker, "package.json"));
    for (const [name, version] of [
      ["@cloudflare/vite-plugin", "1.67.0"],
      ["wrangler", "4.156.1"],
    ] as const) {
      // The plugin exposes an import-only entry, so require.resolve(name) cannot
      // resolve it. Locate its manifest in this worker's Node search path instead.
      const pluginManifest =
        name === "@cloudflare/vite-plugin"
          ? requireWorker.resolve
              .paths(name)
              ?.map((directory) => path.join(directory, name, "package.json"))
              .find(existsSync)
          : undefined;
      if (name === "@cloudflare/vite-plugin")
        assert.ok(pluginManifest, "Missing Cloudflare plugin");
      const entry = realpathSync(
        pluginManifest
          ? path.join(path.dirname(pluginManifest), "dist/index.mjs")
          : requireWorker.resolve(name),
      );
      if (seen.has(entry)) continue;
      seen.add(entry);
      const requireParent = createRequire(entry);
      // Wrangler exports its package manifest; the plugin's entry is dist/index.mjs.
      const manifestPath =
        name === "wrangler"
          ? requireParent.resolve("wrangler/package.json")
          : path.resolve(path.dirname(entry), "../package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
      assert.equal(manifest.version, version, `${name} reviewed version changed`);
      const bundle = readFileSync(entry, "utf8");
      const bundled = [
        ...new Set([...bundle.matchAll(/undici@(\d+\.\d+\.\d+)/g)].map((m) => m[1])),
      ];
      assert.deepEqual(bundled, ["7.30.1"], `${name} bundle changed: redo source review`);
      console.log(
        `[cloudflare-inventory] ${name}@${version}: bundled Undici ${bundled.join(", ")} remains version-affected`,
      );
      const miniflare = realpathSync(requireParent.resolve("miniflare"));
      const requireMiniflare = createRequire(miniflare);
      const mfManifest = JSON.parse(
        readFileSync(requireMiniflare.resolve("miniflare/package.json"), "utf8"),
      ) as { version: string };
      assert.equal(mfManifest.version, "5.20261101.0-beta");
      const undiciManifest = realpathSync(requireMiniflare.resolve("undici/package.json"));
      const undici = JSON.parse(readFileSync(undiciManifest, "utf8")) as { version: string };
      assert.equal(undici.version, "7.30.2", `Unpatched external Undici at ${undiciManifest}`);
      // The synchronous worker uses createRequire(workerData.filename), where
      // its host passes __filename. Check that exact reviewed mechanism remains.
      const source = readFileSync(miniflare, "utf8");
      assert.ok(source.includes("const actualRequire = createRequire(filename);"));
      assert.ok(source.includes('const { Pool, fetch } = actualRequire("undici");'));
      assert.ok(source.includes("filename: __filename"));
      console.log(
        `[cloudflare-inventory] ${miniflare}: external and synchronous-worker resolver -> ${undiciManifest} (${undici.version})`,
      );
    }
  }
  console.log(
    "[cloudflare-inventory] Resolution/source checks only; existing application smoke must still pass. Bundled findings are not fixed.",
  );
}
