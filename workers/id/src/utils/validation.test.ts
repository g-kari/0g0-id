import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { validateRequiredParams, validateParamLengths } from "./validation";

function createTestApp(handler: (c: Parameters<typeof validateRequiredParams>[0]) => Response) {
  const app = new Hono();
  app.get("/test", (c) => handler(c));
  return app;
}

describe("validateRequiredParams", () => {
  it("全パラメータがあれば null を返す", async () => {
    const app = createTestApp((c) => {
      const err = validateRequiredParams(c, [
        { value: "a", message: "a required" },
        { value: "b", message: "b required" },
      ]);
      return c.json({ err: err === null });
    });
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ err: true });
  });

  it("undefined のパラメータがあれば BAD_REQUEST を返す", async () => {
    const app = createTestApp((c) => {
      const err = validateRequiredParams(c, [
        { value: "ok", message: "first" },
        { value: undefined, message: "second is required" },
      ]);
      return err ?? c.json({ ok: true });
    });
    const res = await app.request("/test");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "second is required" },
    });
  });

  it("空文字は不足として扱う", async () => {
    const app = createTestApp((c) => {
      const err = validateRequiredParams(c, [{ value: "", message: "empty" }]);
      return err ?? c.json({ ok: true });
    });
    const res = await app.request("/test");
    expect(res.status).toBe(400);
  });

  it("最初に見つかった不足パラメータのメッセージを返す", async () => {
    const app = createTestApp((c) => {
      const err = validateRequiredParams(c, [
        { value: undefined, message: "first missing" },
        { value: undefined, message: "second missing" },
      ]);
      return err ?? c.json({ ok: true });
    });
    const res = await app.request("/test");
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("first missing");
  });
});

describe("validateParamLengths", () => {
  it("すべて上限以内なら null を返す", async () => {
    const app = createTestApp((c) => {
      const err = validateParamLengths(c, [
        { value: "abc", max: 5, message: "too long" },
        { value: "de", max: 5, message: "too long" },
      ]);
      return c.json({ err: err === null });
    });
    const res = await app.request("/test");
    expect(await res.json()).toEqual({ err: true });
  });

  it("上限超過で BAD_REQUEST を返す", async () => {
    const app = createTestApp((c) => {
      const err = validateParamLengths(c, [{ value: "abcdef", max: 3, message: "val too long" }]);
      return err ?? c.json({ ok: true });
    });
    const res = await app.request("/test");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "val too long" },
    });
  });

  it("undefined はスキップする", async () => {
    const app = createTestApp((c) => {
      const err = validateParamLengths(c, [{ value: undefined, max: 1, message: "too long" }]);
      return err ?? c.json({ ok: true });
    });
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("null はスキップする", async () => {
    const app = createTestApp((c) => {
      const err = validateParamLengths(c, [
        { value: null as string | null, max: 1, message: "too long" },
      ]);
      return err ?? c.json({ ok: true });
    });
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });
});
