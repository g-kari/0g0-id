import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createLogger,
  deletedCountMetadata,
  httpRequestMetadata,
  httpStatusMetadata,
  type LogLevel,
} from "./logger";
import * as shared from "../index";

const fixed = { level: "info", ctx: "metadata-test", msg: "fixed event" };
const levels: LogLevel[] = ["debug", "info", "warn", "error"];
const invalidNumbers = [
  { name: "numeric string", value: "503" },
  { name: "null", value: null },
  { name: "undefined", value: undefined },
  { name: "boolean", value: true },
  { name: "bigint", value: 503n },
  { name: "symbol", value: Symbol("synthetic") },
  { name: "NaN", value: NaN },
  { name: "Infinity", value: Infinity },
  { name: "negative Infinity", value: -Infinity },
  { name: "fraction", value: 200.5 },
  { name: "negative", value: -1 },
  { name: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
] as const;

describe("vetted logger metadata capabilities", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function log(extra: unknown): unknown {
    createLogger("metadata-test").info("fixed event", extra);
    const calls = vi.mocked(console.log).mock.calls;
    return JSON.parse(calls[calls.length - 1][0] as string) as unknown;
  }

  it.each([100, 200, 400, 503, 599])("preserves status %d as its sole data field", (status) => {
    expect(log(httpStatusMetadata(status))).toEqual({ ...fixed, data: { status } });
  });

  it.each([0, 1, 42, Number.MAX_SAFE_INTEGER])(
    "preserves aggregate deletedCount %d",
    (deletedCount) => {
      expect(log(deletedCountMetadata(deletedCount))).toEqual({ ...fixed, data: { deletedCount } });
    },
  );

  it.each(invalidNumbers)(
    "rejects $name from every numeric parameter without coercion",
    ({ value }) => {
      const invalid = value as unknown as number;
      expect(httpStatusMetadata(invalid)).toBeUndefined();
      expect(deletedCountMetadata(invalid)).toBeUndefined();
      expect(httpRequestMetadata("GET", "/users/:id", invalid, 0)).toBeUndefined();
      expect(httpRequestMetadata("GET", "/users/:id", 200, invalid)).toBeUndefined();
      expect(log(httpStatusMetadata(invalid))).toEqual(fixed);
    },
  );

  it.each([0, 99, 600, Number.MAX_SAFE_INTEGER])("rejects out-of-range status %d", (status) => {
    expect(log(httpStatusMetadata(status))).toEqual(fixed);
    expect(log(httpRequestMetadata("GET", "/test", status, 0))).toEqual(fixed);
  });

  it("never inspects boxed numbers, getter objects, functions or revoked Proxies", () => {
    const hook = vi.fn(() => {
      throw new Error("synthetic must not inspect");
    });
    const hostile = Object.defineProperties(
      {},
      {
        status: { get: hook },
        deletedCount: { get: hook },
        toJSON: { get: hook },
        valueOf: { get: hook },
        toString: { get: hook },
        [Symbol.toPrimitive]: { get: hook },
      },
    );
    const trapped = new Proxy(
      {},
      {
        get: hook,
        getPrototypeOf: hook,
        ownKeys: hook,
        getOwnPropertyDescriptor: hook,
      },
    );
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const value of [new Number(503), hostile, trapped, proxy, hook]) {
      const numeric = value as unknown as number;
      expect(httpStatusMetadata(numeric)).toBeUndefined();
      expect(deletedCountMetadata(numeric)).toBeUndefined();
      expect(httpRequestMetadata("GET", "/test", numeric, 0)).toBeUndefined();
      expect(httpRequestMetadata("GET", "/test", 200, numeric)).toBeUndefined();
      expect(httpRequestMetadata(value as unknown as string, "/test", 200, 0)).toBeUndefined();
      expect(httpRequestMetadata("GET", value as unknown as string, 200, 0)).toBeUndefined();
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it.each(levels)("recognizes all approved capability kinds at %s level", (level) => {
    const logger = createLogger("metadata-test");
    const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    logger[level]("fixed event", httpStatusMetadata(403));
    logger[level]("fixed event", deletedCountMetadata(7));
    logger[level]("fixed event", httpRequestMetadata("POST", "/users/:id", 201, 12));
    expect(
      vi.mocked(sink).mock.calls.map(([line]) => JSON.parse(line as string) as unknown),
    ).toEqual([
      { ...fixed, level, data: { status: 403 } },
      { ...fixed, level, data: { deletedCount: 7 } },
      {
        ...fixed,
        level,
        data: { method: "POST", path: "/users/:id", status: 201, elapsed_ms: 12 },
      },
    ]);
  });

  it.each([
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
  ])("accepts vetted method %s", (method) => {
    expect(log(httpRequestMetadata(method, "/api/*", 403, 0))).toEqual({
      ...fixed,
      data: { method, path: "/api/*", status: 403, elapsed_ms: 0 },
    });
  });

  it.each(["/", "/users/:id", "[error]", "[unmatched]", "/" + "x".repeat(255)])(
    "accepts vetted route pattern or fixed classification %s",
    (path) => {
      expect(log(httpRequestMetadata("GET", path, 200, Number.MAX_SAFE_INTEGER))).toEqual({
        ...fixed,
        data: { method: "GET", path, status: 200, elapsed_ms: Number.MAX_SAFE_INTEGER },
      });
    },
  );

  it.each(["", "get", "SYNTHETIC_PRIVATE_METHOD", "GET\n"])(
    "rejects invalid method %s",
    (method) => {
      expect(log(httpRequestMetadata(method, "/test", 200, 0))).toEqual(fixed);
    },
  );

  it.each([
    "",
    "*",
    "/*",
    "/" + "x".repeat(256),
    "/bad path",
    "/private@example.invalid",
    "/%73ecret",
    "/test?token=x",
    "/test#x",
    "https://example.invalid/test",
  ])("rejects malformed/unclassified route metadata %s", (path) => {
    expect(log(httpRequestMetadata("GET", path, 200, 0))).toEqual(fixed);
  });

  it("keeps HTTP path capability and arbitrary string builders out of the public barrel", () => {
    expect(shared).not.toHaveProperty("httpRequestMetadata");
    expect(shared.httpStatusMetadata).toBe(httpStatusMetadata);
    expect(shared.deletedCountMetadata).toBe(deletedCountMetadata);
  });

  it("rejects copied, inherited, wrapped, forged and revoked token lookalikes", () => {
    const token = httpStatusMetadata(503)!;
    const { proxy, revoke } = Proxy.revocable(token, {});
    revoke();
    for (const forged of [
      { ...token },
      Object.create(token) as unknown,
      new Proxy(token, {}),
      proxy,
      { status: 503 },
      { data: { status: 503 } },
      { [Symbol("metadataBrand")]: true },
    ]) {
      expect(log(forged)).toEqual(fixed);
    }
    expect(log(token)).toEqual({ ...fixed, data: { status: 503 } });
  });

  it("does not expose or allow mutation of a capability's stored primitive record", () => {
    const token = deletedCountMetadata(7)!;
    expect(Object.getPrototypeOf(token)).toBeNull();
    expect(Object.isFrozen(token)).toBe(true);
    expect(Reflect.ownKeys(token)).toEqual([]);
    expect(Reflect.set(token, "deletedCount", 999)).toBe(false);
    expect(Reflect.set(token, "data", { deletedCount: 999 })).toBe(false);
    expect(log(token)).toEqual({ ...fixed, data: { deletedCount: 7 } });
    expect(log(token)).toEqual({ ...fixed, data: { deletedCount: 7 } });
  });

  it("uses fresh null-prototype records for both entry and primitive metadata", () => {
    const hook = vi.fn(() => {
      throw new Error("synthetic inherited toJSON");
    });
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    let thrown: unknown;
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true, get: hook });
    try {
      const logger = createLogger("metadata-test");
      logger.info("fixed event", httpStatusMetadata(503));
      logger.info("fixed event", deletedCountMetadata(0));
      logger.info("fixed event", httpRequestMetadata("GET", "/test", 200, 0));
    } catch (error) {
      thrown = error;
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "toJSON", previous);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
    }
    expect(thrown).toBeUndefined();
    expect(hook).not.toHaveBeenCalled();
    expect(
      vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(line as string) as unknown),
    ).toEqual([
      { ...fixed, data: { status: 503 } },
      { ...fixed, data: { deletedCount: 0 } },
      { ...fixed, data: { method: "GET", path: "/test", status: 200, elapsed_ms: 0 } },
    ]);
  });
});
