import { readFileSync } from "node:fs";
import { join } from "node:path";
import userApp from "../workers/user/src/index.ts";
import adminApp from "../workers/admin/src/index.ts";

const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "CONNECT",
]);
const REPO_ROOT = join(__dirname, "..");
export const BFF_DOCUMENTS = ["api-user.md", "api-admin.md"] as const;
export type RouteRegistration = { method: string; path: string };

function routeKey(method: string, path: string): string {
  if (!METHODS.has(method)) throw new Error(`Unsupported endpoint method: ${method}`);
  if (path !== "*" && !path.startsWith("/")) throw new Error(`Invalid endpoint path: ${path}`);
  // Hono normalizes a catch-all registered with '*' to '/*'.
  return `${method} ${path === "*" ? "/*" : path}`;
}

/** Hono's mounted inventory includes factory routes and duplicate handler entries. */
export function registeredEndpoints(routes: readonly RouteRegistration[]): string[] {
  return [
    ...new Set(
      routes
        .filter((route) => route.method !== "ALL")
        .map((route) => routeKey(route.method, route.path)),
    ),
  ].sort();
}

/** Only the first two cells of actual Method/Path table rows are the endpoint contract. */
export function documentedEndpoints(markdown: string): string[] {
  const endpoints: string[] = [];
  let fence: string | undefined;
  let endpointTable = false;
  let expectSeparator = false;
  for (const [index, line] of markdown.split("\n").entries()) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (/^\s*\|\s*Method\s*\|\s*Path\s*\|/i.test(line)) {
      endpointTable = true;
      expectSeparator = true;
      continue;
    }
    if (expectSeparator) {
      if (!/^\s*\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|/.test(line))
        throw new Error(`Line ${index + 1}: Method/Path table requires a delimiter row`);
      expectSeparator = false;
      continue;
    }
    if (!/^\s*\|/.test(line)) endpointTable = false;
    if (!endpointTable) continue;
    const row = /^\s*\|\s*([A-Z]+)\s*\|([^|]*)\|/.exec(line);
    if (!row) throw new Error(`Line ${index + 1}: malformed Method/Path endpoint row`);
    const path = /^\s*`([^`]+)`\s*$/.exec(row[2])?.[1];
    if (!path)
      throw new Error(`Line ${index + 1}: endpoint path must be a single inline-code cell`);
    const key = routeKey(row[1], path);
    if (endpoints.includes(key))
      throw new Error(`Line ${index + 1}: duplicate documented endpoint: ${key}`);
    endpoints.push(key);
  }
  if (expectSeparator) throw new Error("Method/Path table requires a delimiter row");
  if (!endpoints.length) throw new Error("No Method/Path endpoint rows found");
  return endpoints.sort();
}

export function compareEndpointCoverage(
  routes: readonly RouteRegistration[],
  markdown: string,
): string[] {
  const actual = registeredEndpoints(routes);
  if (!actual.length) throw new Error("No method-specific Hono endpoints found");
  const documented = documentedEndpoints(markdown);
  return [
    ...actual
      .filter((key) => !documented.includes(key))
      .map((key) => `Missing documentation: ${key}`),
    ...documented
      .filter((key) => !actual.includes(key))
      .map((key) => `No registered endpoint: ${key}`),
  ];
}

/** Imports register routes only. No request handlers, bindings, credentials, or HTTP calls. */
export function checkBffApiDocs(root: string = REPO_ROOT): string[] {
  const apps = [userApp, adminApp];
  return BFF_DOCUMENTS.flatMap((file, index) => {
    try {
      return compareEndpointCoverage(
        apps[index].routes,
        readFileSync(join(root, "docs", file), "utf8"),
      ).map((error) => `docs/${file}: ${error}`);
    } catch (error) {
      return [`docs/${file}: ${error instanceof Error ? error.message : String(error)}`];
    }
  });
}

export function runBffApiDocsCli(args: string[]): number {
  if (args.length !== 1 || args[0] !== "--check") {
    console.error("Usage: node --import tsx scripts/check-bff-api-docs.ts --check");
    return 2;
  }
  const errors = checkBffApiDocs();
  if (errors.length) {
    console.error(
      `BFF API documentation drift:\n${errors.join("\n")}\nUpdate the Method/Path tables in docs/api-user.md and docs/api-admin.md.`,
    );
    return 1;
  }
  console.log(
    `BFF API endpoint tables are current (user: ${registeredEndpoints(userApp.routes).length}, admin: ${registeredEndpoints(adminApp.routes).length}; read-only check).`,
  );
  return 0;
}

if (require.main === module) process.exitCode = runBffApiDocsCli(process.argv.slice(2));
