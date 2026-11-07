/**
 * Cloudflare Workers 向け構造化ログ。
 * 任意の extra は参照せず、専用 helper が発行した metadata token だけを記録する。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

type LogData = Readonly<Record<string, string | number>>;

interface LogEntry {
  level: LogLevel;
  ctx: string;
  msg: string;
  data?: LogData;
}

declare const metadataBrand: unique symbol;
/** Opaque capability. Its identity, not its properties, grants access to vetted metadata. */
export interface LogMetadata {
  readonly [metadataBrand]: true;
}

// Never inspect extra, even to recognize a token. WeakMap lookup does not invoke Proxy traps.
const metadata = new WeakMap<object, LogData>();

function storeMetadata(data: LogData): LogMetadata {
  const token = Object.freeze(Object.create(null)) as LogMetadata;
  metadata.set(token, Object.freeze(data));
  return token;
}

function isHttpStatus(value: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function isNonnegativeSafeInteger(value: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Preserve only a validated HTTP status, never an arbitrary object or response body. */
export function httpStatusMetadata(status: number): LogMetadata | undefined {
  if (!isHttpStatus(status)) return undefined;
  const data = Object.create(null) as Record<string, number>;
  data.status = status;
  return storeMetadata(data);
}

/** Preserve only a validated aggregate cleanup count, never row/user identifiers. */
export function deletedCountMetadata(deletedCount: number): LogMetadata | undefined {
  if (!isNonnegativeSafeInteger(deletedCount)) return undefined;
  const data = Object.create(null) as Record<string, number>;
  data.deletedCount = deletedCount;
  return storeMetadata(data);
}

const HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "CONNECT",
  "TRACE",
  "[other]",
]);

/**
 * Internal request-middleware capability. Deliberately absent from the public shared barrel.
 * path must already be a registered route pattern or a fixed classification, never a request URL.
 * Primitive validation is defense in depth; route provenance remains the middleware's responsibility.
 */
export function httpRequestMetadata(
  method: string,
  path: string,
  status: number,
  elapsedMs: number,
): LogMetadata | undefined {
  if (
    typeof method !== "string" ||
    !HTTP_METHODS.has(method) ||
    typeof path !== "string" ||
    !(
      path === "[error]" ||
      path === "[unmatched]" ||
      (path.startsWith("/") && path !== "/*" && path.length <= 256 && !/[\s@%?#]/.test(path))
    ) ||
    !isHttpStatus(status) ||
    !isNonnegativeSafeInteger(elapsedMs)
  ) {
    return undefined;
  }
  const data = Object.create(null) as Record<string, string | number>;
  data.method = method;
  data.path = path;
  data.status = status;
  data.elapsed_ms = elapsedMs;
  return storeMetadata(data);
}

// Retain unknown for source compatibility. Legacy extras are intentionally ignored without inspection.
type LoggerFn = (msg: string, extra?: unknown) => void;

export interface Logger {
  debug: LoggerFn;
  info: LoggerFn;
  warn: LoggerFn;
  error: LoggerFn;
}

/** Context and message remain caller-supplied strings; keep them fixed and free of personal data. */
export function createLogger(context: string): Logger {
  function log(level: LogLevel, msg: string, extra?: unknown): void {
    const entry = Object.create(null) as LogEntry;
    entry.level = level;
    entry.ctx = context;
    entry.msg = msg;
    // WeakMap.get accepts non-object inputs too, returning undefined without coercion/inspection.
    const data = metadata.get(extra as object);
    if (data !== undefined) entry.data = data;
    const line = JSON.stringify(entry);
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (msg, extra) => log("debug", msg, extra),
    info: (msg, extra) => log("info", msg, extra),
    warn: (msg, extra) => log("warn", msg, extra),
    error: (msg, extra) => log("error", msg, extra),
  };
}
