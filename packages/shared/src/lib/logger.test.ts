import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createLogger, type LogLevel } from "./logger";

const CANARY = "synthetic-private-token-person@example.invalid";
const levels: LogLevel[] = ["debug", "info", "warn", "error"];

function hostileProperties(): { extra: unknown; reads: () => number } {
  let reads = 0;
  const extra = Object.create(Error.prototype) as object;
  for (const key of ["message", "stack", "cause", "name", "toJSON", "status", "deletedCount"]) {
    Object.defineProperty(extra, key, {
      get() {
        reads++;
        throw new Error(`must not inspect ${key}: ${CANARY}`);
      },
    });
  }
  return { extra, reads: () => reads };
}

function hostileProxy(): { extra: unknown; reads: () => number } {
  let reads = 0;
  const trap = (): never => {
    reads++;
    throw new Error(CANARY);
  };
  return {
    extra: new Proxy(
      {},
      {
        get: trap,
        getPrototypeOf: trap,
        ownKeys: trap,
        getOwnPropertyDescriptor: trap,
        has: trap,
      },
    ),
    reads: () => reads,
  };
}

const legacyExtras = [
  { name: "ordinary Error", create: () => new Error(CANARY, { cause: CANARY }) },
  { name: "thrown string", create: () => CANARY },
  { name: "thrown object", create: () => ({ reason: CANARY, userId: CANARY, failedAttempts: 3 }) },
  { name: "legacy status object", create: () => ({ status: 503 }) },
  { name: "legacy cleanup object", create: () => ({ deletedCount: 42 }) },
  { name: "large string", create: () => CANARY.repeat(2048) },
  { name: "number", create: () => 42 },
  { name: "boolean", create: () => true },
  { name: "null", create: () => null },
  { name: "undefined", create: () => undefined },
  { name: "bigint", create: () => 42n },
  { name: "symbol", create: () => Symbol(CANARY) },
  { name: "function", create: () => () => CANARY },
  { name: "array", create: () => [CANARY] },
  {
    name: "cycle",
    create: () => {
      const extra: { secret: string; self?: unknown } = { secret: CANARY };
      extra.self = extra;
      return extra;
    },
  },
  {
    name: "revoked Proxy",
    create: () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    },
  },
  {
    name: "forged token",
    create: () =>
      Object.assign(Object.create(null) as object, { data: { status: 503 }, status: 503 }),
  },
] as const;

describe("createLogger privacy boundary", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function expectFixedEntry(level: LogLevel): void {
    const sink = level === "error" ? errorSpy : level === "warn" ? warnSpy : logSpy;
    expect(sink).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ level, ctx: "test-context", msg: "fixed event" }),
    );
    expect(logSpy.mock.calls.length + warnSpy.mock.calls.length + errorSpy.mock.calls.length).toBe(
      1,
    );
  }

  it.each(levels)("preserves %s context/message and console routing", (level) => {
    createLogger("test-context")[level]("fixed event");
    expectFixedEntry(level);
  });

  describe.each(levels)("%s extras", (level) => {
    it.each(legacyExtras)("ignores $name without serializing it", ({ create }) => {
      const extra: unknown = create();
      expect(() => createLogger("test-context")[level]("fixed event", extra)).not.toThrow();
      expectFixedEntry(level);
    });

    it("does not read hostile Error message/stack/cause/name or metadata getters", () => {
      const { extra, reads } = hostileProperties();
      expect(() => createLogger("test-context")[level]("fixed event", extra)).not.toThrow();
      expect(reads()).toBe(0);
      expectFixedEntry(level);
    });

    it("does not trigger Proxy inspection traps", () => {
      const { extra, reads } = hostileProxy();
      expect(() => createLogger("test-context")[level]("fixed event", extra)).not.toThrow();
      expect(reads()).toBe(0);
      expectFixedEntry(level);
    });

    it("never calls extra toJSON or primitive conversion hooks", () => {
      const hook = vi.fn(() => {
        throw new Error(CANARY);
      });
      const extra = { toJSON: hook, toString: hook, valueOf: hook, [Symbol.toPrimitive]: hook };
      expect(() => createLogger("test-context")[level]("fixed event", extra)).not.toThrow();
      expect(hook).not.toHaveBeenCalled();
      expectFixedEntry(level);
    });
  });

  it("uses a null-prototype entry so inherited toJSON cannot inspect log records", () => {
    const hook = vi.fn(() => {
      throw new Error(CANARY);
    });
    let thrown: unknown;
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true, get: hook });
    try {
      createLogger("test-context").info("fixed event", hostileProperties().extra);
    } catch (error) {
      thrown = error;
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "toJSON", previous);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
    }
    expect(thrown).toBeUndefined();
    expect(hook).not.toHaveBeenCalled();
    expectFixedEntry("info");
  });
});
