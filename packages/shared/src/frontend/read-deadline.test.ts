import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ReadDeadlineError, readWithDeadline } from "./read-deadline";

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("complete read deadline", () => {
  for (const phase of ["headers", "success-body", "error-body"])
    it(`settles a stalled ${phase} at exactly30seconds even if abort is ignored`, async () => {
      const controller = new AbortController(),
        gate = deferred<string>();
      const read = vi.fn(async (signal: AbortSignal): Promise<string> => {
        expect(signal).toBe(controller.signal);
        if (phase !== "headers") await Promise.resolve();
        return await gate.promise;
      });
      const result = readWithDeadline(read, controller, 30_000);
      const rejected = expect(result).rejects.toBeInstanceOf(ReadDeadlineError);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(controller.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(controller.signal.aborted).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      gate.resolve("late");
      await Promise.resolve();
    });
  it("a successful complete read clears the timer and does not later abort", async () => {
    const controller = new AbortController();
    await expect(readWithDeadline(async () => "ok", controller, 30_000)).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.signal.aborted).toBe(false);
  });
  it("a timely rejection keeps its original error and clears the timer", async () => {
    const controller = new AbortController(),
      error = new Error("synthetic network failure");
    await expect(
      readWithDeadline(
        async () => {
          throw error;
        },
        controller,
        30_000,
      ),
    ).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.signal.aborted).toBe(false);
  });
  it("a synchronous reader failure also cleans timer and listener", async () => {
    const controller = new AbortController(),
      remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(
      readWithDeadline(
        () => {
          throw new Error("sync");
        },
        controller,
        30_000,
      ),
    ).rejects.toThrow("sync");
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("external cancellation settles an unabortable read immediately and removes its timer", async () => {
    const controller = new AbortController(),
      gate = deferred<string>();
    const result = readWithDeadline(() => gate.promise, controller, 30_000);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    gate.reject(new Error("late ignored transport error"));
    await Promise.resolve();
  });
  it("a previously aborted read never invokes its callback", async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn(async () => "no");
    await expect(readWithDeadline(read, controller, 30_000)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("timeout beats an error-body reader that catches cancellation", async () => {
    const controller = new AbortController();
    const result = readWithDeadline(
      async (signal) => {
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          ),
        ).catch(() => ({}));
        throw new Error("HTTP503");
      },
      controller,
      30_000,
    );
    const rejected = expect(result).rejects.toBeInstanceOf(ReadDeadlineError);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });
  it("the completed old deadline cannot abort a newer controller", async () => {
    const first = new AbortController(),
      second = new AbortController(),
      gate = deferred<string>();
    await readWithDeadline(async () => "first", first, 30_000);
    const result = readWithDeadline(() => gate.promise, second, 30_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
    gate.resolve("new");
    await expect(result).resolves.toBe("new");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("completion immediately before the boundary wins and prevents timeout", async () => {
    const controller = new AbortController(),
      gate = deferred<string>();
    const result = readWithDeadline(() => gate.promise, controller, 30_000);
    await vi.advanceTimersByTimeAsync(29_999);
    gate.resolve("on time");
    await expect(result).resolves.toBe("on time");
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleanup removes the signal listener on normal completion", async () => {
    const controller = new AbortController(),
      add = vi.spyOn(controller.signal, "addEventListener"),
      remove = vi.spyOn(controller.signal, "removeEventListener");
    await readWithDeadline(async () => null, controller, 30_000);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
  });
});
