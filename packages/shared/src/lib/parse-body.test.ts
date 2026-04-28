import { describe, it, expect } from "vite-plus/test";
import { Hono } from "hono";
import { z } from "zod";
import { parseJsonBody } from "./parse-body";

const TestSchema = z.object({
  name: z.string(),
  age: z.number().int().positive(),
});

function buildApp() {
  const app = new Hono();
  app.post("/test", async (c) => {
    const result = await parseJsonBody(c, TestSchema);
    if (!result.ok) return result.response;
    return c.json({ ok: true, data: result.data });
  });
  return app;
}

describe("parseJsonBody", () => {
  const app = buildApp();

  it("有効な JSON ボディをパースして data を返す", async () => {
    const res = await app.request(
      new Request("https://example.com/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "牛木", age: 25 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: { name: string; age: number } }>();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe("牛木");
    expect(body.data.age).toBe(25);
  });

  it("不正な JSON ボディ → 400 BAD_REQUEST を返す", async () => {
    const res = await app.request(
      new Request("https://example.com/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid JSON body");
  });

  it("Zod バリデーション失敗 → 400 VALIDATION_ERROR と details を返す", async () => {
    const res = await app.request(
      new Request("https://example.com/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "牛木", age: -1 }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{
      error: { code: string; message: string; details: { path: string[]; message: string }[] };
    }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toHaveLength(1);
    expect(body.error.details[0].path).toEqual(["age"]);
  });

  it("必須フィールド欠如 → 400 VALIDATION_ERROR を返す", async () => {
    const res = await app.request(
      new Request("https://example.com/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "牛木" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{
      error: { code: string; details: { path: string[]; message: string }[] };
    }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toHaveLength(1);
    expect(body.error.details[0].path).toEqual(["age"]);
  });

  it("空オブジェクト → 全フィールドのエラーを details に含む", async () => {
    const res = await app.request(
      new Request("https://example.com/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{
      error: { code: string; details: { path: string[]; message: string }[] };
    }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toHaveLength(2);
    const paths = body.error.details.map((d) => d.path[0]);
    expect(paths).toContain("name");
    expect(paths).toContain("age");
  });

  it("スキーマ通過時は ok: true と data を返す", async () => {
    const res = await app.request(
      new Request("https://example.com/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Alice", age: 30 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; data: unknown }>();
    expect(body.ok).toBe(true);
    expect(body.data).toBeTruthy();
  });

  it("型が違うフィールド → 全フィールドのエラーを返す", async () => {
    const res = await app.request(
      new Request("https://example.com/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: 123, age: "twenty" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{
      error: { code: string; details: { path: string[]; message: string }[] };
    }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toHaveLength(2);
  });

  it("null ボディ → VALIDATION_ERROR を返す", async () => {
    const res = await app.request(
      new Request("https://example.com/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(null),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});
