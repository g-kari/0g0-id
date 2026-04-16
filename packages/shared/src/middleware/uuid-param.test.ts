import { describe, it, expect } from "vite-plus/test";
import { Hono } from "hono";
import { uuidParamMiddleware } from "./uuid-param";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

function buildApp(allowValues?: readonly string[]) {
  const app = new Hono();
  app.use("/:id", uuidParamMiddleware("id", { allowValues }));
  app.use("/:id/*", uuidParamMiddleware("id", { allowValues }));
  app.get("/:id", (c) => c.json({ id: c.req.param("id") }));
  app.get("/:id/detail", (c) => c.json({ id: c.req.param("id") }));
  return app;
}

describe("uuidParamMiddleware", () => {
  it("有効なUUIDは通過する", async () => {
    const app = buildApp();
    const res = await app.request(`https://example.com/${VALID_UUID}`);
    expect(res.status).toBe(200);
    const json = await res.json<{ id: string }>();
    expect(json.id).toBe(VALID_UUID);
  });

  it("無効なIDは400を返す", async () => {
    const app = buildApp();
    const res = await app.request("https://example.com/not-a-uuid");
    expect(res.status).toBe(400);
    const json = await res.json<{ error: { code: string; message: string } }>();
    expect(json.error.code).toBe("BAD_REQUEST");
    expect(json.error.message).toBe("Invalid id ID format");
  });

  it("サブパスでも無効なIDは400を返す", async () => {
    const app = buildApp();
    const res = await app.request("https://example.com/not-a-uuid/detail");
    expect(res.status).toBe(400);
  });

  it("allowValuesに含まれる値は通過する", async () => {
    const app = buildApp(["me"]);
    const res = await app.request("https://example.com/me");
    expect(res.status).toBe(200);
    const json = await res.json<{ id: string }>();
    expect(json.id).toBe("me");
  });

  it("allowValuesに含まれない非UUID値は400を返す", async () => {
    const app = buildApp(["me"]);
    const res = await app.request("https://example.com/you");
    expect(res.status).toBe(400);
  });

  it("大文字UUIDも通過する", async () => {
    const app = buildApp();
    const res = await app.request(`https://example.com/${VALID_UUID.toUpperCase()}`);
    expect(res.status).toBe(200);
  });
});
