/**
 * Disposable, loopback-only application integration smoke test (Node 22).
 * Runs the real Cloudflare Vite configs and built Workers; never deploys.
 * Static assets use isolated publicDir fixtures. They prove local serving, not
 * production asset rollout (the generated id config currently omits assets).
 */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import type { Plugin, ViteDevServer } from "vite-plus";
import type { TestHarness, WorkerHandle } from "wrangler";
import type { IdpEnv } from "../packages/shared/src/types";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workers = ["id", "user", "admin", "mcp"] as const;
const names = { id: "0g0-id", user: "0g0-id-user", admin: "0g0-id-admin", mcp: "0g0-mcp" };
const origins = {
  id: "http://127.0.0.1:8951",
  user: "http://127.0.0.1:8952",
  admin: "http://127.0.0.1:8953",
  mcp: "http://127.0.0.1:8954",
};
const marker = "CI_SMOKE_BLOCKED_EGRESS";
let denied = 0;
let workerDenied = false;
let checks = 0;
let childFailure: Error | undefined;
const childModeIndex = process.argv.indexOf("--vite-worker");
const processProbe = process.argv.includes("--process-probe");
function blockedChildRequest(error?: Error): void {
  if ((childModeIndex >= 0 || processProbe) && process.connected)
    process.send?.({
      type: "blocked-egress",
      diagnostic: error?.stack ?? "Worker guard marker observed by Vite logger",
    });
}

function loopback(host: string): boolean {
  return ["127.0.0.1", "::1", "[::1]", "localhost"].includes(host.toLowerCase());
}
function block(destination: string): never {
  denied++;
  const error = new Error(`${marker}: ${destination}`);
  blockedChildRequest(error);
  throw error;
}
function allowUrl(input: string | URL): void {
  const url = new URL(input);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || !loopback(url.hostname))
    block(url.origin);
}
/** Guard Node HTTP/HTTPS, fetch, and raw TCP before importing Cloudflare tools.
 * No response is mocked and no destination is rewritten. Rejected attempts fail
 * the test even if application code catches the rejection. This is a test guard,
 * not a replacement for an OS firewall or the runner's security restrictions.
 */
function installNetworkGuard(stateRoot: string): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    allowUrl(input instanceof Request ? input.url : input);
    return originalFetch(input, init);
  };
  function checkRequest(args: unknown[]): void {
    const first = args[0];
    if (typeof first === "string" || first instanceof URL) allowUrl(first);
    for (const arg of args.slice(0, 2)) {
      if (arg !== null && typeof arg === "object" && !(arg instanceof URL)) {
        const options = arg as { hostname?: string; host?: string; socketPath?: string };
        if (options.socketPath) {
          if (!path.resolve(options.socketPath).startsWith(`${stateRoot}${path.sep}`))
            block(`non-fixture Unix socket: ${path.resolve(options.socketPath)}`);
        } else if (!loopback(options.hostname ?? options.host ?? "localhost"))
          block(options.hostname ?? options.host ?? "unknown");
      }
    }
  }
  for (const module of [http, https]) {
    module.request = new Proxy(module.request, {
      apply(target, receiver, args: unknown[]) {
        checkRequest(args);
        return Reflect.apply(target, receiver, args) as http.ClientRequest;
      },
    });
    module.get = new Proxy(module.get, {
      apply(target, receiver, args: unknown[]) {
        checkRequest(args);
        return Reflect.apply(target, receiver, args) as http.ClientRequest;
      },
    });
  }
  net.Socket.prototype.connect = new Proxy(
    Reflect.get(net.Socket.prototype, "connect") as typeof net.Socket.prototype.connect,
    {
      apply(target, receiver, args: unknown[]) {
        // Node may pass its normalized [options, callback] tuple internally.
        const values = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
        const first = values[0];
        if (typeof first === "string") {
          if (!path.resolve(first).startsWith(`${stateRoot}${path.sep}`))
            block(`non-fixture Unix socket: ${path.resolve(first)}`);
        } else if (typeof first === "number") {
          if (typeof values[1] === "string" && !loopback(values[1])) block(values[1]);
        } else if (first !== null && typeof first === "object") {
          const options = first as { host?: string; path?: string };
          if (options.path) {
            if (!path.resolve(options.path).startsWith(`${stateRoot}${path.sep}`))
              block(`non-fixture Unix socket: ${path.resolve(options.path)}`);
          } else if (!loopback(options.host ?? "localhost")) block(options.host ?? "unknown");
        } else block("unrecognized TCP destination");
        return Reflect.apply(target, receiver, args) as net.Socket;
      },
    },
  );
  syncBuiltinESMExports();
}

// Applies only to the disposable Worker entry. Safe explicit-redirect local
// fetches and service bindings are unchanged. Auto-follow is rejected before
// native fetch: a loopback redirect must not become an external request.
function guardWorkerSource(code: string): string {
  return `const __ciFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow');
  if (!['manual', 'error'].includes(redirect) || !['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    console.error('${marker}');
    throw new Error('${marker}');
  }
  return __ciFetch.call(globalThis, input, init);
};\n${code}`;
}
function outboundGuard(entry: string): Plugin {
  return {
    name: "ci-smoke-reject-external-fetch",
    enforce: "pre",
    transform(code, id) {
      if (id.split("?")[0] !== entry) return;
      return guardWorkerSource(code);
    },
  };
}
/** Wrangler's unexpected-config-field warning also performs an npm version
 * lookup. Its bundled update-check cache avoids that ancillary request for one
 * hour. Seed only this disposable process's cache with its installed version;
 * this is an offline fixture, not a claim about the npm registry's latest tag.
 * Config warnings/validation and every network rejection remain enabled.
 */
async function prepareOfflineWranglerUpdateCache(state: string): Promise<void> {
  const installed = JSON.parse(
    await readFile(createRequire(import.meta.url).resolve("wrangler/package.json"), "utf8"),
  ) as { name: string; version: string };
  assert.equal(installed.name, "wrangler");
  assert.match(installed.version, /^\d+\.\d+\.\d+(?:[-+].*)?$/);
  const directory = process.env.TMPDIR;
  assert.ok(directory && path.resolve(directory).startsWith(`${state}${path.sep}`));
  const cache = path.join(directory, "update-check");
  await mkdir(cache, { recursive: true });
  await writeFile(
    path.join(cache, "wrangler-latest.json"),
    JSON.stringify({ latest: installed.version, lastUpdate: Date.now() }),
  );
}
function ok(label: string): void {
  assert.equal(denied, 0, "Node outbound request attempted");
  assert.equal(workerDenied, false, "Worker outbound request attempted");
  assert.equal(childFailure, undefined, "Vite subprocess failed");
  console.log(`[app-smoke] PASS ${++checks}: ${label}`);
}
async function response(url: string, status = 200): Promise<Response> {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  assert.equal(res.status, status, url);
  return res;
}
async function health(url: string, worker: string, status = 200): Promise<void> {
  const res = await response(url, status);
  const body = (await res.json()) as { status?: string; worker?: string; error?: { code: string } };
  if (status === 200) {
    assert.equal(body.status, "ok");
    assert.equal(body.worker, worker);
  } else assert.ok(body.error?.code);
  ok(`${worker} real dev health/auth gate`);
}
async function copyCheckout(destination: string): Promise<void> {
  await cp(repository, destination, {
    recursive: true,
    filter(source) {
      const parts = path.relative(repository, source).split(path.sep);
      return !parts.some(
        (part) =>
          [".git", "node_modules", ".wrangler", ".astro"].includes(part) ||
          part.startsWith(".env") ||
          part.startsWith(".dev.vars"),
      );
    },
  });
  // Shallow dependency links keep package bytes reusable while each fixture
  // node_modules directory (including .vite-temp/config caches) is disposable.
  async function linkDependencies(source: string, target: string): Promise<void> {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if ([".cache", ".vite", ".vite-temp"].includes(entry.name)) continue;
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      if (entry.name.startsWith("@")) {
        await linkDependencies(from, to);
        continue;
      }
      let linkTarget = from;
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(from);
        const relative = path.relative(repository, resolved);
        if (!relative.startsWith("..") && !relative.split(path.sep).includes("node_modules"))
          linkTarget = path.join(destination, relative);
      }
      await symlink(linkTarget, to);
    }
  }
  await linkDependencies(
    path.join(repository, "node_modules"),
    path.join(destination, "node_modules"),
  );
  for (const worker of workers)
    await linkDependencies(
      path.join(repository, "workers", worker, "node_modules"),
      path.join(destination, "workers", worker, "node_modules"),
    );
  for (const worker of ["user", "admin"])
    await linkDependencies(
      path.join(repository, "workers", worker, "frontend/node_modules"),
      path.join(destination, "workers", worker, "frontend/node_modules"),
    );
}
async function selfTest(state: string, pure = false): Promise<void> {
  installNetworkGuard(state);
  for (const url of [
    "https://example.invalid",
    "http://127.0.0.1.example.invalid",
    "file:///tmp/test",
  ]) {
    assert.throws(() => allowUrl(url), /CI_SMOKE_BLOCKED_EGRESS/);
  }
  assert.throws(() => http.get("http://example.invalid"), /CI_SMOKE_BLOCKED_EGRESS/);
  assert.throws(() => https.get("https://example.invalid"), /CI_SMOKE_BLOCKED_EGRESS/);
  assert.throws(() => new net.Socket().connect(443, "example.invalid"), /CI_SMOKE_BLOCKED_EGRESS/);
  assert.throws(() => http.request({ hostname: "example.invalid" }), /CI_SMOKE_BLOCKED_EGRESS/);
  assert.throws(
    () => globalThis.fetch(new Request("https://example.invalid")),
    /CI_SMOKE_BLOCKED_EGRESS/,
  );
  assert.throws(
    () => new net.Socket().connect({ path: "/not-a-fixture/socket" }),
    /CI_SMOKE_BLOCKED_EGRESS/,
  );
  // Pure guard contract test: only here use a sentinel fetch, never in app runs.
  let forwarded: unknown[] = [];
  let rejected = false;
  const globals = {
    fetch(input: unknown, init: unknown) {
      forwarded = [input, init];
      return "sentinel";
    },
  };
  runInNewContext(guardWorkerSource(""), {
    globalThis: globals,
    URL,
    Request,
    console: {
      error() {
        rejected = true;
      },
    },
  });
  const input = new Request("http://127.0.0.1:8951/local");
  const init = { method: "POST", body: "unchanged", redirect: "manual" };
  assert.equal(globals.fetch(input, init), "sentinel");
  assert.deepEqual(forwarded, [input, init]);
  assert.throws(
    () => globals.fetch("https://example.invalid", undefined),
    /CI_SMOKE_BLOCKED_EGRESS/,
  );
  assert.equal(rejected, true);
  // A local redirector returning an external Location must never be called in
  // automatic-follow mode. Reject before the sentinel/native fetch is reached.
  for (const local of [
    "http://127.0.0.1:8951/redirect-to-external",
    new URL("http://127.0.0.1:8951/redirect-to-external"),
    new Request("http://127.0.0.1:8951/redirect-to-external"),
  ]) {
    const before: unknown[] = forwarded;
    assert.throws(() => globals.fetch(local, undefined), /CI_SMOKE_BLOCKED_EGRESS/);
    assert.equal(forwarded, before);
  }
  const manual = new Request("http://127.0.0.1:8951/local", { redirect: "manual" });
  assert.equal(globals.fetch(manual, undefined), "sentinel");
  const before: unknown[] = forwarded;
  assert.throws(() => globals.fetch(manual, { redirect: "follow" }), /CI_SMOKE_BLOCKED_EGRESS/);
  assert.equal(forwarded, before);
  for (const mode of ["manual", "error"])
    assert.equal(globals.fetch(input, { redirect: mode }), "sentinel");
  const validCookie = "__Host-user-session=fixture; HttpOnly; Secure; SameSite=Lax; Path=/";
  assertSessionCookieFlags(validCookie);
  for (const missing of ["HttpOnly; ", "Secure; ", "SameSite=Lax; ", "; Path=/"]) {
    const cookies = {
      headers: {
        getSetCookie: () => [
          "__Host-user-oauth-state=; HttpOnly; Secure; SameSite=Lax; Path=/",
          validCookie.replace(missing, ""),
        ],
      },
    };
    assert.throws(() => assertSessionCookieFlags(cookieLine(cookies, "__Host-user-session")));
  }
  assert.throws(() => assertSessionCookieFlags(`${validCookie}; Domain=localhost`));
  denied = 0;
  for (const url of ["http://127.0.0.1:8951", "http://localhost:8952", "http://[::1]:8953"])
    allowUrl(url);
  await processSelfTest(state);
  const originalFailure = new Error("original smoke failure");
  const cleanupFailure = new Error("cleanup failure");
  let lastCleanupRan = false;
  await assert.rejects(
    completeCleanup(
      [originalFailure],
      [
        () => {
          throw cleanupFailure;
        },
        () => {
          lastCleanupRan = true;
        },
      ],
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [originalFailure, cleanupFailure]);
      return true;
    },
  );
  assert.equal(lastCleanupRan, true, "Cleanup must continue after an earlier cleanup error");
  if (pure) {
    ok(
      "pure Node/Worker guards, argument forwarding, loopback classification and exact session-cookie assertions (no server started)",
    );
    return;
  }
  const server = http.createServer((_req, res) => {
    res.end("loopback preserved");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(
      await (await response(`http://127.0.0.1:${address.port}`)).text(),
      "loopback preserved",
    );
    ok("network guard rejects external destinations and preserves actual loopback HTTP");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

type ViteChild = {
  child: ChildProcess;
  worker: (typeof workers)[number];
  mode: "dev" | "build";
  closing: boolean;
};
/** Cloudflare's plugin keeps module-global dev state. Each real Vite project
 * must run in its own process, as the repository's separate dev commands do.
 */
async function startViteChild(
  mode: "dev" | "build",
  worker: (typeof workers)[number],
  root: string,
  state: string,
  publicDir: string,
  children: ViteChild[],
  probe = false,
): Promise<void> {
  const child = fork(
    fileURLToPath(import.meta.url),
    probe ? ["--process-probe", worker] : ["--vite-worker", mode, worker, root, state, publicDir],
    {
      cwd: path.join(root, "workers", worker),
      env: process.env,
      execArgv: process.execArgv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const managed: ViteChild = { child, worker, mode, closing: false };
  children.push(managed);
  for (const [stream, output] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const)
    stream?.on("data", (chunk: Buffer) => {
      output.write(chunk);
      if (chunk.toString().includes(marker)) workerDenied = true;
    });
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(
      () => reject(new Error(`${worker} ${mode} subprocess did not become ready in time`)),
      mode === "dev" ? 30_000 : 90_000,
    );
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message)) return;
      if (message.type === "blocked-egress") {
        workerDenied = true;
        console.error(`[app-smoke] ${worker} ${mode} subprocess rejected egress`);
        if ("diagnostic" in message && typeof message.diagnostic === "string")
          console.error(message.diagnostic);
      }
      if (message.type === "ready" && "worker" in message && message.worker === worker) {
        ready = true;
        if (mode === "dev") {
          clearTimeout(timer);
          resolve();
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      childFailure = error;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!managed.closing && (mode === "dev" || code !== 0)) {
        const error = new Error(
          `${worker} ${mode} subprocess exited unexpectedly (${code ?? signal})`,
        );
        childFailure = error;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (mode === "build") {
        if (code === 0 && ready) resolve();
        else reject(new Error(`${worker} build subprocess did not complete successfully`));
      } else if (!ready && !managed.closing)
        reject(new Error(`${worker} dev subprocess closed before readiness`));
    });
  });
}
async function stopViteChildren(children: ViteChild[]): Promise<void> {
  const results = await Promise.allSettled(
    children.map(async (managed) => {
      managed.closing = true;
      const { child } = managed;
      if (child.exitCode !== null || child.signalCode !== null) {
        if (child.exitCode !== 0 || child.signalCode !== null)
          throw new Error(
            `${managed.worker} Vite process failed before cleanup (${child.exitCode ?? child.signalCode})`,
          );
        return;
      }
      await new Promise<void>((resolve, reject) => {
        let forced = false;
        const terminate = setTimeout(() => {
          forced = true;
          child.kill("SIGTERM");
        }, 5_000);
        const kill = setTimeout(() => {
          forced = true;
          child.kill("SIGKILL");
        }, 10_000);
        child.once("close", (code, signal) => {
          clearTimeout(terminate);
          clearTimeout(kill);
          if (forced)
            reject(new Error(`${managed.worker} Vite shutdown required forced termination`));
          else if (code !== 0 || signal !== null)
            reject(new Error(`${managed.worker} Vite shutdown failed (${code ?? signal})`));
          else resolve();
        });
        if (child.connected)
          child.send({ type: "close" }, (error) => {
            if (error) child.kill("SIGTERM");
          });
        else child.kill("SIGTERM");
      });
    }),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Vite subprocess cleanup failed",
    );
}
/** Transport-only controls; never start a Vite server or mock an app response. */
async function runProcessProbe(): Promise<void> {
  assert.ok(process.connected, "Internal process probe requires its parent IPC channel");
  const worker = process.argv[process.argv.indexOf("--process-probe") + 1];
  let failOnClose = false;
  await new Promise<void>((resolve) => {
    process.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message)) return;
      if (message.type === "close") {
        if (failOnClose) process.exitCode = 1;
        resolve();
      }
      if (message.type === "probe-block") {
        try {
          block("intentional pure process probe");
        } catch {
          /* Verify caught rejection still reaches parent. */
        }
      }
      if (message.type === "probe-close-fail") {
        failOnClose = true;
        process.send?.({ type: "probe-close-armed" });
      }
      if (message.type === "probe-fail") {
        process.exitCode = 9;
        resolve();
      }
    });
    process.once("disconnect", resolve);
    process.once("SIGTERM", resolve);
    process.send?.({ type: "ready", worker });
  });
  if (process.connected) process.disconnect();
}
async function processSelfTest(state: string): Promise<void> {
  const root = path.join(state, "checkout");
  const children: ViteChild[] = [];
  for (const worker of ["id", "user", "admin"] as const)
    await mkdir(path.join(root, "workers", worker), { recursive: true });
  try {
    for (const worker of ["id", "user", "admin"] as const)
      await startViteChild(
        "dev",
        worker,
        root,
        state,
        path.join(state, "public", worker),
        children,
        true,
      );
    assert.ok(children[0].child.pid && children[1].child.pid);
    assert.notEqual(
      children[0].child.pid,
      children[1].child.pid,
      "Each Vite project requires a distinct process",
    );
    const blocked = new Promise<unknown>((resolve) => children[1].child.once("message", resolve));
    children[1].child.send({ type: "probe-block" });
    const diagnostic = (await blocked) as { type: string; diagnostic: string };
    assert.equal(diagnostic.type, "blocked-egress");
    assert.match(diagnostic.diagnostic, /CI_SMOKE_BLOCKED_EGRESS: intentional pure process probe/);
    assert.match(diagnostic.diagnostic, /at block/);
    assert.equal(workerDenied, true, "Caught child rejection must reach parent");
    const exited = new Promise<void>((resolve) => children[0].child.once("exit", () => resolve()));
    children[0].child.send({ type: "probe-fail" });
    await exited;
    assert.ok(childFailure, "Unexpected child exit must fail parent controls");
    const armed = new Promise<void>((resolve) =>
      children[1].child.once("message", () => resolve()),
    );
    children[1].child.send({ type: "probe-close-fail" });
    await armed;
  } finally {
    await assert.rejects(stopViteChildren(children), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.errors.length,
        2,
        "Already-failed and failed-shutdown probes must both be rejected",
      );
      return true;
    });
    assert.equal(children[2].child.exitCode, 0, "Normal shutdown control must exit successfully");
    // Reset intentional negative controls only in this transport self-test.
    workerDenied = false;
    childFailure = undefined;
  }
  ok(
    "separate subprocess identities, ready/blocked/failure IPC, shutdown error rejection and successful close (no Vite/app started)",
  );
}
async function runViteChild(): Promise<void> {
  const [mode, candidateWorker, root, state, publicDir] = process.argv.slice(childModeIndex + 1);
  assert.ok(mode === "dev" || mode === "build");
  assert.ok(workers.includes(candidateWorker as (typeof workers)[number]));
  const worker = candidateWorker as (typeof workers)[number];
  assert.ok(path.isAbsolute(state) && path.basename(state).startsWith("0g0-app-smoke-"));
  assert.equal(root, path.join(state, "checkout"));
  assert.equal(publicDir, path.join(state, "public", worker));
  process.env.HOME = path.join(state, "home", worker, mode);
  process.env.XDG_CONFIG_HOME = path.join(state, "config", worker, mode);
  process.env.TMPDIR = path.join(state, "tmp", worker, mode);
  await mkdir(process.env.TMPDIR, { recursive: true });
  await prepareOfflineWranglerUpdateCache(state);
  installNetworkGuard(state);
  const { createServer, createBuilder, createLogger } = await import("vite-plus");
  const logger = createLogger();
  for (const level of ["error", "warn", "info"] as const) {
    const original = logger[level].bind(logger);
    logger[level] = (message, options) => {
      if (message.includes(marker)) blockedChildRequest();
      original(message, options);
    };
  }
  const workerRoot = path.join(root, "workers", worker);
  const config = {
    root: workerRoot,
    configFile: path.join(workerRoot, "vite.config.ts"),
    publicDir,
    cacheDir: path.join(state, "vite-cache", worker, mode),
    customLogger: logger,
    plugins: [outboundGuard(path.join(workerRoot, "src/index.ts"))],
  };
  if (mode === "build") {
    // The plugin config supplies a multi-environment buildApp. Legacy build()
    // builds only the client environment and cannot validate Worker bundles.
    const builder = await createBuilder(config);
    await builder.buildApp();
    await new Promise<void>((resolve, reject) =>
      process.send?.({ type: "ready", worker }, (error) => (error ? reject(error) : resolve())),
    );
    process.disconnect();
    return;
  }
  let server: ViteDevServer | undefined;
  try {
    server = await createServer({
      ...config,
      server: {
        host: "127.0.0.1",
        port: Number(new URL(origins[worker]).port),
        strictPort: true,
        open: false,
      },
    });
    await server.listen();
    const stop = new Promise<void>((resolve) => {
      process.on("message", (message: unknown) => {
        if (message && typeof message === "object" && "type" in message && message.type === "close")
          resolve();
      });
      process.once("disconnect", resolve);
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    process.send?.({ type: "ready", worker });
    await stop;
  } finally {
    await server?.close();
    if (process.connected) process.disconnect();
  }
}
async function completeCleanup(
  failures: unknown[],
  operations: (() => void | Promise<void>)[],
): Promise<void> {
  for (const operation of operations)
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  if (failures.length) throw new AggregateError(failures, "Application smoke or cleanup failed");
}
async function main(): Promise<void> {
  const state = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "0g0-app-smoke-"));
  const children: ViteChild[] = [];
  let harness: TestHarness | undefined;
  const oldCwd = process.cwd();
  const failures: unknown[] = [];
  const timer = setTimeout(() => {
    console.error("[app-smoke] exceeded six-minute deadline");
    process.exit(1);
  }, 360_000);
  try {
    if (process.argv.includes("--self-test-pure")) {
      await selfTest(state, true);
      return;
    }
    if (process.argv.includes("--self-test")) {
      await selfTest(state);
      return;
    }
    const root = path.join(state, "checkout");
    await copyCheckout(root);
    process.env.HOME = path.join(state, "home");
    process.env.XDG_CONFIG_HOME = path.join(state, "config");
    process.env.TMPDIR = path.join(state, "tmp");
    process.env.MINIFLARE_REGISTRY_PATH = path.join(state, "registry.json");
    process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
    process.env.CLOUDFLARE_VITE_FORCE_LOCAL = "true";
    process.env.WRANGLER_SEND_METRICS = "false";
    process.env.WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING = "";
    delete process.env.VITEST;
    // CI must never inherit account credentials, even from a caller's shell.
    for (const key of Object.keys(process.env))
      if (
        /TOKEN|SECRET|PASSWORD|CREDENTIAL|ACCESS_KEY|^(CLOUDFLARE|CF)_(API|ACCOUNT|EMAIL)/.test(key)
      )
        delete process.env[key];
    await mkdir(process.env.TMPDIR, { recursive: true });
    await prepareOfflineWranglerUpdateCache(state);
    installNetworkGuard(state);
    const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
    const keys = await generateKeyPair("ES256", { extractable: true });
    const privateKey = await exportPKCS8(keys.privateKey);
    const publicKey = await exportSPKI(keys.publicKey);
    const secret = () => randomBytes(32).toString("hex");
    const userSecret = secret();
    const adminSecret = secret();
    const userSessionSecret = secret();
    const adminSessionSecret = secret();
    const idVars = {
      IDP_ORIGIN: origins.id,
      USER_ORIGIN: origins.user,
      ADMIN_ORIGIN: origins.admin,
      JWT_PRIVATE_KEY: privateKey,
      JWT_PUBLIC_KEY: publicKey,
      COOKIE_SECRET: secret(),
      GOOGLE_CLIENT_ID: "ci-disposable-google-id",
      GOOGLE_CLIENT_SECRET: "ci-disposable-google-secret",
      INTERNAL_SERVICE_SECRET_USER: userSecret,
      INTERNAL_SERVICE_SECRET_ADMIN: adminSecret,
      PAIRWISE_SALT: secret(),
    };
    const vars = {
      id: idVars,
      user: {
        IDP_ORIGIN: origins.id,
        SELF_ORIGIN: origins.user,
        SESSION_SECRET: userSessionSecret,
        INTERNAL_SERVICE_SECRET_SELF: userSecret,
      },
      admin: {
        IDP_ORIGIN: origins.id,
        SELF_ORIGIN: origins.admin,
        SESSION_SECRET: adminSessionSecret,
        INTERNAL_SERVICE_SECRET_SELF: adminSecret,
      },
      mcp: { IDP_ORIGIN: origins.id, MCP_ORIGIN: origins.mcp },
    };
    for (const worker of workers)
      await writeFile(
        path.join(root, "workers", worker, ".dev.vars"),
        Object.entries(vars[worker])
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join("\n"),
      );
    const publicDirs = Object.fromEntries(
      workers.map((worker) => [worker, path.join(state, "public", worker)]),
    ) as Record<(typeof workers)[number], string>;
    const { buildAssets } = (await import(
      pathToFileURL(path.join(root, "workers/id/scripts/build-assets.ts")).href
    )) as typeof import("../workers/id/scripts/build-assets");
    await buildAssets({
      distDir: pathToFileURL(`${publicDirs.id}${path.sep}`),
      idpOrigin: origins.id,
      publicKeyPem: publicKey,
    });
    for (const worker of ["user", "admin"] as const) {
      const built = path.join(root, "workers", worker, "dist/client");
      await cp(built, publicDirs[worker], {
        recursive: true,
        filter(source) {
          const relative = path.relative(built, source);
          return (
            relative === "" ||
            (!relative.split(path.sep).some((part) => part.startsWith("0g0_")) &&
              (!path.extname(relative) ||
                /\.(html|svg|txt|js|css|woff2?|png|jpg|webp)$/.test(relative)))
          );
        },
      });
    }
    await mkdir(publicDirs.mcp, { recursive: true });
    for (const worker of workers)
      await startViteChild("dev", worker, root, state, publicDirs[worker], children);
    await health(`${origins.id}/api/health`, "id");
    await health(`${origins.user}/api/health`, "user");
    await health(`${origins.admin}/api/health`, "admin", 401);
    const mcpHealth = await response(`${origins.mcp}/health`);
    assert.equal(((await mcpHealth.json()) as { status: string }).status, "ok");
    ok("mcp real dev health");
    for (const worker of ["user", "admin"] as const) {
      assert.match(await (await response(`${origins[worker]}/`)).text(), /<html/i);
      assert.match(await (await response(`${origins[worker]}/favicon.svg`)).text(), /<svg/i);
      const assets = await readdir(path.join(publicDirs[worker], "_astro"));
      const asset = assets.find((name) => /\.(js|css)$/.test(name));
      assert.ok(asset, `${worker} frontend must be built before app smoke`);
      assert.ok((await (await response(`${origins[worker]}/_astro/${asset}`)).text()).length > 0);
      ok(`${worker} fixture HTML/favicon/Astro asset through real dev server`);
    }
    const discovery = (await (
      await response(`${origins.id}/.well-known/openid-configuration`)
    ).json()) as { issuer: string };
    assert.equal(discovery.issuer, origins.id);
    const jwks = (await (await response(`${origins.id}/.well-known/jwks.json`)).json()) as {
      keys: { kid: string }[];
    };
    assert.equal(jwks.keys.length, 1);
    assert.ok(jwks.keys[0].kid);
    assert.equal(
      ((await (await response(`${origins.id}/docs/openapi.json`)).json()) as { openapi: string })
        .openapi,
      "3.1.0",
    );
    ok("id discovery/JWKS/OpenAPI fixture serving");
    // An invalid provider never redirects to a real provider. Do not follow any
    // redirects; hit the actual configured rate-limit binding and require 429.
    let limited: Response | undefined;
    for (let count = 0; count < 25; count++) {
      const res = await fetch(
        `${origins.id}/auth/login?${new URLSearchParams({ provider: "ci-invalid", state: "ci-local-rate-limit", redirect_to: `${origins.user}/auth/callback` })}`,
        {
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.status === 429) {
        limited = res;
        break;
      }
      assert.equal(res.status, 400, "invalid provider must fail locally without redirect");
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "BAD_REQUEST");
    }
    assert.ok(limited, "real id auth rate-limit binding must enforce configured limit");
    assert.ok(limited.headers.get("retry-after"));
    ok("actual development auth rate limiter returns 429/Retry-After");
    for (const worker of workers)
      await startViteChild("build", worker, root, state, publicDirs[worker], children);
    const { createTestHarness } = await import("wrangler");
    const inputs = [];
    for (const worker of workers) {
      const generated = path.join(
        root,
        "workers",
        worker,
        "dist",
        names[worker].replaceAll("-", "_"),
        "wrangler.json",
      );
      // Preserve the generated runtime config. Only id's dedicated asset fixture
      // needs an explicit test config; this does not validate production rollout.
      let configPath = generated;
      if (worker === "id") {
        const config = JSON.parse(await readFile(generated, "utf8")) as Record<string, unknown>;
        config.assets = {
          directory: publicDirs.id,
          binding: "ASSETS",
          not_found_handling: "none",
          run_worker_first: [
            "/*",
            "!/.well-known/jwks.json",
            "!/.well-known/openid-configuration",
            "!/.well-known/oauth-authorization-server",
            "!/docs/openapi.json",
            "!/docs/external/openapi.json",
          ],
        };
        configPath = path.join(path.dirname(generated), "ci-fixture.wrangler.json");
        await writeFile(configPath, JSON.stringify(config));
      }
      inputs.push({ configPath, secrets: vars[worker] });
    }
    process.chdir(root);
    harness = createTestHarness({ root, workers: inputs });
    await harness.listen();
    const id = harness.getWorker<IdpEnv>(names.id);
    await id.applyD1Migrations("DB");
    const env = await id.getEnv();
    assert.ok(env.LINK_TOKEN_KV);
    await env.LINK_TOKEN_KV.put("ci-smoke", "local-only");
    assert.equal(await env.LINK_TOKEN_KV.get("ci-smoke"), "local-only");
    ok("real generated Worker configs, D1 migrations and KV read/write");
    // Application-level authentication and scheduled cleanup cases below.
    await applicationCases(harness, env);
    workerDenied ||= JSON.stringify(harness.getLogs()).includes(marker);
    ok("no unexpected Node/Worker external request attempted");
    console.log(
      `[app-smoke] ${checks} checks passed; disposable local runtime only; asset fixtures do not prove production rollout`,
    );
  } catch (error) {
    failures.push(error);
  } finally {
    // Preserve the application/guard error while still completing every cleanup
    // operation. A cleanup assertion must not replace the original diagnostic.
    await completeCleanup(failures, [
      () => process.chdir(oldCwd),
      async () => {
        await harness?.close();
      },
      () => stopViteChildren(children),
      () => rm(state, { recursive: true, force: true }),
      () => clearTimeout(timer),
      () => {
        assert.equal(denied, 0, "Node outbound request attempted during cleanup");
        assert.equal(workerDenied, false, "Worker/subprocess outbound request attempted");
        assert.equal(childFailure, undefined, "Vite subprocess failed");
      },
    ]);
  }
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
type FixtureUser = { id: string; email: string; name: string; role: "user" | "admin" };
type AppResponse = Awaited<ReturnType<WorkerHandle<IdpEnv>["fetch"]>>;
type CookieResponse = { headers: { getSetCookie(): string[] } };
function cookieLine(res: CookieResponse, name: string): string {
  const line = res.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  assert.ok(line, `Missing ${name} cookie`);
  return line;
}
function cookiePair(res: CookieResponse, name: string): string {
  return cookieLine(res, name).split(";")[0];
}
function assertSessionCookieFlags(line: string): void {
  for (const flag of [
    /(?:^|;)\s*HttpOnly(?:;|$)/i,
    /(?:^|;)\s*Secure(?:;|$)/i,
    /(?:^|;)\s*SameSite=Lax(?:;|$)/i,
    /(?:^|;)\s*Path=\/(?:;|$)/i,
  ])
    assert.match(line, flag);
  assert.doesNotMatch(line, /(?:^|;)\s*Domain=/i, "__Host session cookie must be host-only");
}

async function json<T>(res: AppResponse, status: number, label: string): Promise<T> {
  assert.equal(res.status, status, label);
  return (await res.json()) as T;
}
async function applicationCases(harness: TestHarness, env: IdpEnv): Promise<void> {
  const id = harness.getWorker<IdpEnv>(names.id);
  const db = env.DB;
  const user: FixtureUser = {
    id: randomUUID(),
    email: "user@smoke.invalid",
    name: "Smoke User",
    role: "user",
  };
  const admin: FixtureUser = {
    id: randomUUID(),
    email: "admin@smoke.invalid",
    name: "Smoke Admin",
    role: "admin",
  };
  await db.batch(
    [user, admin].map((fixture) =>
      db
        .prepare(
          "INSERT INTO users (id, google_sub, email, email_verified, name, role) VALUES (?, ?, ?, 1, ?, ?)",
        )
        .bind(fixture.id, `local-${fixture.id}`, fixture.email, fixture.name, fixture.role),
    ),
  );
  assert.equal((await id.fetch(`${origins.id}/api/users/me`)).status, 401);
  for (const worker of ["user", "admin"] as const) {
    assert.equal(
      (
        await harness
          .getWorker(names[worker])
          .fetch(`${origins[worker]}/api/${worker === "user" ? "me" : "metrics"}`)
      ).status,
      401,
    );
  }
  for (const secret of [undefined, "incorrect-local-secret"]) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) headers["X-Internal-Secret"] = secret;
    const deniedResponse = await id.fetch(`${origins.id}/auth/exchange`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        code: "unregistered-local-code",
        redirect_to: `${origins.user}/auth/callback`,
      }),
    });
    assert.equal(
      (await json<{ error: { code: string } }>(deniedResponse, 403, "internal-secret guard")).error
        .code,
      "FORBIDDEN",
    );
  }
  ok("unauthenticated APIs and missing/wrong internal secrets remain rejected");
  const sessionIds: string[] = [];
  for (const [workerName, fixture, success] of [
    ["user", user, "/profile"],
    ["admin", admin, "/dashboard"],
  ] as const) {
    const worker = harness.getWorker(names[workerName]);
    const origin = origins[workerName];
    const login = await worker.fetch(`${origin}/auth/login`, { redirect: "manual" });
    assert.equal(login.status, 302);
    const location = login.headers.get("location");
    assert.ok(location);
    const target = new URL(location);
    assert.equal(target.origin, origins.id);
    const state = target.searchParams.get("state");
    assert.ok(state);
    const stateCookie = cookiePair(login, `__Host-${workerName}-oauth-state`);
    const code = randomBytes(32).toString("base64url");
    const codeId = randomUUID();
    await db
      .prepare(
        "INSERT INTO auth_codes (id, user_id, code_hash, redirect_to, expires_at, provider) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        codeId,
        fixture.id,
        sha256(code),
        `${origin}/auth/callback`,
        "2099-01-01T00:00:00.000Z",
        "google",
      )
      .run();
    const callbackUrl = (callbackState: string) =>
      `${origin}/auth/callback?${new URLSearchParams({ code, state: callbackState })}`;
    const wrong = await worker.fetch(callbackUrl(`${state}-wrong`), {
      redirect: "manual",
      headers: { Cookie: stateCookie },
    });
    assert.equal(wrong.status, 302);
    assert.equal(wrong.headers.get("location"), "/?error=state_mismatch");
    assert.equal(
      (
        await db
          .prepare("SELECT used_at FROM auth_codes WHERE id = ?")
          .bind(codeId)
          .first<{ used_at: string | null }>()
      )?.used_at,
      null,
    );
    const callback = await worker.fetch(callbackUrl(state), {
      redirect: "manual",
      headers: { Cookie: stateCookie },
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), success);
    const cookie = cookiePair(callback, `__Host-${workerName}-session`);
    assertSessionCookieFlags(cookieLine(callback, `__Host-${workerName}-session`));
    assert.ok(
      (
        await db
          .prepare("SELECT used_at FROM auth_codes WHERE id = ?")
          .bind(codeId)
          .first<{ used_at: string | null }>()
      )?.used_at,
    );
    const stored = await db
      .prepare(
        "SELECT id, user_id, bff_origin, expires_at, revoked_at FROM bff_sessions WHERE user_id = ? AND bff_origin = ?",
      )
      .bind(fixture.id, origin)
      .first<{
        id: string;
        user_id: string;
        bff_origin: string;
        expires_at: number;
        revoked_at: number | null;
      }>();
    assert.ok(stored);
    assert.equal(stored.user_id, fixture.id);
    assert.equal(stored.bff_origin, origin);
    assert.equal(stored.revoked_at, null);
    assert.ok(stored.expires_at > Date.now() / 1000);
    sessionIds.push(stored.id);
    const api = `${origin}/api/${workerName === "user" ? "me" : "metrics"}`;
    const result = await json<{
      data: { id?: string; email?: string; total_users?: number; admin_users?: number };
    }>(
      await worker.fetch(api, { headers: { Cookie: cookie } }),
      200,
      `${workerName} real BFF/IdP service binding`,
    );
    if (workerName === "user") {
      assert.equal(result.data.id, user.id);
      assert.equal(result.data.email, user.email);
    } else {
      assert.equal(result.data.total_users, 2);
      assert.equal(result.data.admin_users, 1);
    }
    assert.equal(
      (await worker.fetch(api, { headers: { Cookie: `${cookie}corrupted` } })).status,
      401,
    );
    if (workerName === "admin")
      assert.equal(
        (await worker.fetch(`${origin}/api/health`, { headers: { Cookie: cookie } })).status,
        200,
      );
    ok(
      `${workerName} real callback/code consumption/ES256/encrypted cookie/service binding and tampered-cookie rejection`,
    );
  }
  const { SignJWT, importPKCS8 } = await import("jose");
  const jwks = await json<{ keys: { kid: string; alg: string }[] }>(
    await id.fetch(`${origins.id}/.well-known/jwks.json`),
    200,
    "ephemeral JWKS",
  );
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].alg, "ES256");
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, "ES256");
  async function token(
    fixture: FixtureUser,
    issuer = origins.id,
    audience = origins.id,
    payloadKid = true,
    jti = randomUUID(),
  ): Promise<string> {
    return await new SignJWT({
      email: fixture.email,
      role: fixture.role,
      ...(payloadKid ? { kid: jwks.keys[0].kid } : {}),
    })
      .setProtectedHeader({ alg: "ES256", kid: jwks.keys[0].kid })
      .setIssuer(issuer)
      .setSubject(fixture.id)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .setJti(jti)
      .sign(privateKey);
  }
  const mcp = harness.getWorker(names.mcp);
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "local-smoke", version: "1" },
    },
  };
  async function rpc(
    bearer?: string,
    session?: string,
    body: object = initialize,
  ): Promise<AppResponse> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (session) headers["mcp-session-id"] = session;
    return await mcp.fetch(`${origins.mcp}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }
  assert.equal((await rpc()).status, 401);
  const bearer = await token(admin);
  const initialized = await rpc(bearer);
  const initializedBody = await json<{ result: { serverInfo: { name: string } } }>(
    initialized,
    200,
    "MCP initialize",
  );
  assert.equal(initializedBody.result.serverInfo.name, "0g0-id-mcp");
  const session = initialized.headers.get("mcp-session-id");
  assert.ok(session);
  assert.equal(
    (
      await db
        .prepare("SELECT user_id FROM mcp_sessions WHERE id = ?")
        .bind(session)
        .first<{ user_id: string }>()
    )?.user_id,
    admin.id,
  );
  const list = await json<{ result: { isError?: boolean; content: { text: string }[] } }>(
    await rpc(bearer, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_users", arguments: { search: "smoke.invalid" } },
    }),
    200,
    "MCP D1 tool",
  );
  assert.equal(list.result.isError, undefined);
  const listed = JSON.parse(list.result.content[0].text) as {
    users: { id: string }[];
    pagination: { total: number };
  };
  assert.equal(listed.pagination.total, 2);
  assert.deepEqual(listed.users.map((entry) => entry.id).sort(), [user.id, admin.id].sort());
  for (const invalid of [
    await token(admin, "https://wrong.smoke.invalid"),
    await token(admin, origins.id, "https://wrong.smoke.invalid"),
    await token(admin, origins.id, origins.id, false),
  ])
    assert.equal((await rpc(invalid)).status, 401);
  assert.equal((await rpc(await token(user))).status, 403);
  const jti = randomUUID();
  const revoked = await token(admin, origins.id, origins.id, true, jti);
  await db
    .prepare("INSERT INTO revoked_access_tokens (jti, expires_at) VALUES (?, ?)")
    .bind(jti, Math.floor(Date.now() / 1000) + 3600)
    .run();
  assert.equal(
    (
      await id.fetch(`${origins.id}/api/users/me`, {
        headers: { Authorization: `Bearer ${revoked}` },
      })
    ).status,
    401,
  );
  assert.equal((await rpc(revoked)).status, 401);
  assert.equal(
    (
      await mcp.fetch(`${origins.mcp}/mcp`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bearer}`, "mcp-session-id": session },
      })
    ).status,
    204,
  );
  assert.equal(
    await db.prepare("SELECT id FROM mcp_sessions WHERE id = ?").bind(session).first(),
    null,
  );
  ok("MCP actual JWKS/JWT/D1 tool/session deletion and issuer/audience/role/revocation rejection");
  await scheduledCleanup(id, env, admin.id, sessionIds[0]);
}
async function scheduledCleanup(
  id: WorkerHandle<IdpEnv>,
  env: IdpEnv,
  adminId: string,
  sessionId: string,
): Promise<void> {
  const db = env.DB;
  const prefix = "smoke-cleanup-";
  const key = (name: string) => `${prefix}${name}`;
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const old = "2000-01-01T00:00:00.000Z";
  const future = "2099-01-01T00:00:00.000Z";
  const recent = new Date(nowMs).toISOString();
  const service = randomUUID();
  await db
    .prepare(
      "INSERT INTO services (id, name, client_id, client_secret_hash, owner_user_id) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      service,
      "Local cleanup fixture",
      `local-${service}`,
      sha256("unused-local-secret"),
      adminId,
    )
    .run();
  type CleanupCase = {
    table: string;
    column: string;
    columns: string[];
    rows: (string | number | null)[][];
    retained: string[];
  };
  // Identifiers are fixed test literals. Timestamps follow each real schema.
  const cases: CleanupCase[] = [
    {
      table: "auth_codes",
      column: "id",
      columns: ["id", "user_id", "code_hash", "redirect_to", "expires_at", "used_at"],
      rows: [
        [
          key("expired"),
          adminId,
          sha256("auth-expired"),
          `${origins.user}/auth/callback`,
          old,
          null,
        ],
        [key("live"), adminId, sha256("auth-live"), `${origins.user}/auth/callback`, future, null],
        [
          key("used"),
          adminId,
          sha256("auth-used"),
          `${origins.user}/auth/callback`,
          future,
          recent,
        ],
      ],
      retained: ["live"],
    },
    {
      table: "device_codes",
      column: "id",
      columns: ["id", "device_code_hash", "user_code", "service_id", "expires_at"],
      rows: [
        [key("expired"), sha256("device-expired"), "LOCAL-OLD", service, old],
        [key("live"), sha256("device-live"), "LOCAL-NEW", service, future],
      ],
      retained: ["live"],
    },
    {
      table: "mcp_sessions",
      column: "id",
      columns: ["id", "created_at", "last_active_at", "user_id"],
      rows: [
        [key("expired"), nowMs - 7200000, nowMs - 7200000, adminId],
        [key("live"), nowMs, nowMs, adminId],
      ],
      retained: ["live"],
    },
    {
      table: "revoked_access_tokens",
      column: "jti",
      columns: ["jti", "expires_at"],
      rows: [
        [key("expired"), now - 7200],
        [key("live"), now + 7200],
      ],
      retained: ["live"],
    },
    {
      table: "refresh_tokens",
      column: "id",
      columns: ["id", "user_id", "token_hash", "family_id", "expires_at", "revoked_at"],
      rows: [
        [key("expired"), adminId, sha256("refresh-expired"), randomUUID(), old, null],
        [key("live"), adminId, sha256("refresh-live"), randomUUID(), future, null],
        [key("revoked-old"), adminId, sha256("refresh-revoked-old"), randomUUID(), future, old],
        [
          key("revoked-recent"),
          adminId,
          sha256("refresh-revoked-recent"),
          randomUUID(),
          future,
          recent,
        ],
      ],
      retained: ["live", "revoked-recent"],
    },
    {
      table: "dbsc_challenges",
      column: "nonce",
      columns: ["nonce", "session_id", "created_at", "expires_at", "consumed_at"],
      rows: [
        [key("expired-old"), sessionId, now - 7300, now - 7200, null],
        [key("consumed-old"), sessionId, now - 7300, now + 7200, now - 7200],
        [key("live"), sessionId, now, now + 7200, null],
        [key("expired-grace"), sessionId, now - 20, now - 10, null],
        [key("consumed-grace"), sessionId, now - 20, now + 7200, now - 10],
      ],
      retained: ["live", "expired-grace", "consumed-grace"],
    },
  ];
  async function fixtureKeys(test: CleanupCase): Promise<string[]> {
    const result = await db
      .prepare(
        `SELECT ${test.column} AS fixture_key FROM ${test.table} WHERE ${test.column} LIKE ? ORDER BY ${test.column}`,
      )
      .bind(`${prefix}%`)
      .all<{ fixture_key: string }>();
    return result.results.map((row: { fixture_key: string }) => row.fixture_key);
  }
  for (const test of cases) {
    for (const row of test.rows)
      await db
        .prepare(
          `INSERT INTO ${test.table} (${test.columns.join(", ")}) VALUES (${test.columns.map(() => "?").join(", ")})`,
        )
        .bind(...row)
        .run();
    assert.deepEqual(
      await fixtureKeys(test),
      test.rows.map((row) => String(row[0])).sort(),
      `${test.table}: fixture seeded`,
    );
  }
  assert.equal(
    (await id.scheduled({ cron: "0 0 * * *", scheduledTime: new Date() })).outcome,
    "ok",
  );
  for (const test of cases)
    assert.deepEqual(
      await fixtureKeys(test),
      test.retained.map(key).sort(),
      `${test.table}: expired removed and live/grace rows retained`,
    );
  ok("actual scheduled handler awaits all six cleanup operations and preserves live/grace rows");
}
void (processProbe ? runProcessProbe() : childModeIndex >= 0 ? runViteChild() : main()).catch(
  (error) => {
    console.error("[app-smoke] FAILED", error);
    process.exitCode = 1;
    if ((childModeIndex >= 0 || processProbe) && process.connected) process.disconnect();
  },
);
