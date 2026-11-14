import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "../workers/id/src/index.ts";
import { EXTERNAL_OPENAPI } from "../workers/id/src/routes/openapi/external-spec.ts";
import { INTERNAL_OPENAPI } from "../workers/id/src/routes/openapi/internal-spec.ts";
import {
  documentedEndpoints,
  registeredEndpoints,
  type RouteRegistration,
} from "./check-bff-api-docs.ts";

const METHODS = new Set([
  "get",
  "head",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "trace",
  "connect",
]);
const PATH_FIELDS = new Set(["$ref", "summary", "description", "parameters", "servers"]);
const REPO_ROOT = join(__dirname, "..");

/** Hono `:name` and OpenAPI `{name}` are the same path parameter. */
export function canonicalEndpoint(method: string, path: string): string {
  if (!/^[A-Z]+$/.test(method)) throw new Error(`Unsupported endpoint method: ${method}`);
  const normalized = path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ":$1");
  if (normalized !== "*" && !normalized.startsWith("/")) {
    throw new Error(`Invalid endpoint path: ${path}`);
  }
  return `${method} ${normalized === "*" ? "/*" : normalized}`;
}

export function routeInventory(routes: readonly RouteRegistration[]): string[] {
  return registeredEndpoints(routes).map((key) => {
    const method = key.slice(0, key.indexOf(" "));
    return canonicalEndpoint(method, key.slice(method.length + 1));
  });
}

/** Method/path operations only. Path-item metadata and vendor extensions are not operations. */
export function openApiOperations(paths: Record<string, unknown>): string[] {
  const operations: string[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`Invalid OpenAPI path item: ${path}`);
    }
    for (const [method, operation] of Object.entries(item)) {
      if (PATH_FIELDS.has(method) || method.startsWith("x-")) continue;
      if (!METHODS.has(method))
        throw new Error(`Invalid OpenAPI method: ${method.toUpperCase()} ${path}`);
      if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
        throw new Error(`Invalid OpenAPI operation: ${method.toUpperCase()} ${path}`);
      }
      const key = canonicalEndpoint(method.toUpperCase(), path);
      if (operations.includes(key)) throw new Error(`Duplicate OpenAPI operation: ${key}`);
      operations.push(key);
    }
  }
  return operations.sort();
}

export function markdownInventory(markdown: string): string[] {
  const operations = documentedEndpoints(markdown).map((key) => {
    const method = key.slice(0, key.indexOf(" "));
    return canonicalEndpoint(method, key.slice(method.length + 1));
  });
  const duplicate = operations.find((key, index) => operations.indexOf(key) !== index);
  if (duplicate) throw new Error(`Duplicate documented endpoint: ${duplicate}`);
  return operations.sort();
}

export function missingKeys(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): string[] {
  return actual.filter((key) => !expected.includes(key)).map((key) => `${label}: ${key}`);
}

/**
 * Every mounted IdP route must appear in the internal OpenAPI document and in
 * docs/api-id.md. The external document is the public subset of that inventory.
 * Handlers, bindings, and credentials are not used.
 */
export function compareIdpApiDocs(
  routes: readonly RouteRegistration[],
  internalPaths: Record<string, unknown>,
  externalPaths: Record<string, unknown>,
  markdown: string,
): string[] {
  const actual = routeInventory(routes);
  if (!actual.length) throw new Error("No method-specific IdP endpoints found");
  const internal = openApiOperations(internalPaths);
  const external = openApiOperations(externalPaths);
  const documented = markdownInventory(markdown);
  return [
    ...missingKeys(actual, internal, "Missing internal specification"),
    ...missingKeys(internal, actual, "No registered endpoint for internal specification"),
    ...missingKeys(external, actual, "No registered endpoint for external specification"),
    ...missingKeys(
      external,
      internal,
      "External specification is absent from the internal specification",
    ),
    ...missingKeys(actual, documented, "Missing docs/api-id.md row"),
    ...missingKeys(documented, actual, "No registered endpoint for docs/api-id.md"),
  ];
}

export function checkIdpApiDocs(root: string = REPO_ROOT): string[] {
  return compareIdpApiDocs(
    app.routes,
    INTERNAL_OPENAPI.paths,
    EXTERNAL_OPENAPI.paths,
    readFileSync(join(root, "docs", "api-id.md"), "utf8"),
  );
}

export function runIdpApiDocsCli(args: string[]): number {
  if (args.length !== 1 || args[0] !== "--check") {
    console.error("Usage: node --import tsx scripts/check-idp-api-docs.ts --check");
    return 2;
  }
  try {
    const errors = checkIdpApiDocs();
    if (errors.length) {
      console.error(
        `IdP API documentation drift:\n${errors.join("\n")}\nUpdate workers/id/src/routes/openapi and the Method/Path tables in docs/api-id.md, then run: vp run docs:api:generate`,
      );
      return 1;
    }
    const count = routeInventory(app.routes).length;
    console.log(
      `IdP API inventory is current (${count} endpoints; internal OpenAPI, external subset, and docs/api-id.md; read-only check).`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (require.main === module) process.exitCode = runIdpApiDocsCli(process.argv.slice(2));
