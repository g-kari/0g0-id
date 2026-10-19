import { app } from "../workers/id/src/index.ts";
import { INTERNAL_OPENAPI } from "../workers/id/src/routes/openapi/internal-spec.ts";
import { registeredEndpoints, type RouteRegistration } from "./check-bff-api-docs.ts";

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
const isMetricsPath = (path: string): boolean =>
  path === "/api/metrics" || path.startsWith("/api/metrics/");

/** Read the mounted application inventory without invoking handlers or bindings. */
export function compareIdpMetricsCoverage(
  routes: readonly RouteRegistration[],
  paths: Record<string, unknown>,
): string[] {
  const actual = registeredEndpoints(routes.filter(({ path }) => isMetricsPath(path)));
  if (!actual.length) throw new Error("No method-specific IdP metrics endpoints found");
  const documented = Object.entries(paths)
    .flatMap(([path, item]) => {
      if (!isMetricsPath(path)) return [];
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`Invalid OpenAPI metrics path item: ${path}`);
      }
      return Object.entries(item)
        .filter(([method]) => METHODS.has(method))
        .map(([method, operation]) => {
          if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
            throw new Error(`Invalid OpenAPI metrics operation: ${method.toUpperCase()} ${path}`);
          }
          return `${method.toUpperCase()} ${path}`;
        });
    })
    .sort();
  return [
    ...actual
      .filter((key) => !documented.includes(key))
      .map((key) => `Missing metrics specification: ${key}`),
    ...documented
      .filter((key) => !actual.includes(key))
      .map((key) => `No registered metrics endpoint: ${key}`),
  ];
}

export function checkIdpMetricsDocs(): string[] {
  return compareIdpMetricsCoverage(app.routes, INTERNAL_OPENAPI.paths);
}

export function runIdpMetricsDocsCli(args: string[]): number {
  if (args.length !== 1 || args[0] !== "--check") {
    console.error("Usage: node --import tsx scripts/check-idp-metrics-docs.ts --check");
    return 2;
  }
  try {
    const errors = checkIdpMetricsDocs();
    if (errors.length) {
      console.error(
        `IdP metrics documentation drift:\n${errors.join("\n")}\nUpdate the internal OpenAPI metrics paths and regenerate the API reference.`,
      );
      return 1;
    }
    console.log(
      `IdP metrics operation inventory is current (${registeredEndpoints(app.routes.filter(({ path }) => isMetricsPath(path))).length} endpoints; read-only check).`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (require.main === module) process.exitCode = runIdpMetricsDocsCli(process.argv.slice(2));
