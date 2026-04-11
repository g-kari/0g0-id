import { describe, it, expect } from "vite-plus/test";
import { Hono } from "hono";
import { bodyLimitMiddleware } from "./body-limit";

function buildApp(maxSize?: number) {
  const app = new Hono();
  app.use("*", bodyLimitMiddleware(maxSize));
  app.post("/upload", async (c) => {
    const body = await c.req.text();
    return c.json({ ok: true, size: body.length });
  });
  return app;
}

describe("bodyLimitMiddleware", () => {
  it("デフォルト64KB以下のボディは通過する", async () => {
    const app = buildApp();
    const body = "a".repeat(1000);
    const res = await app.request(
      new Request("https://example.com/upload", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json<{ ok: boolean }>();
    expect(json.ok).toBe(true);
  });

  it("デフォルト64KBを超えるボディ → 413 PAYLOAD_TOO_LARGE を返す", async () => {
    const app = buildApp();
    const body = "a".repeat(65 * 1024 + 1);
    const res = await app.request(
      new Request("https://example.com/upload", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
      }),
    );
    expect(res.status).toBe(413);
    const json = await res.json<{ error: { code: string; message: string } }>();
    expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(json.error.message).toBe("Request body too large");
  });

  it("カスタムサイズ: 100バイト以下は通過する", async () => {
    const app = buildApp(100);
    const body = "a".repeat(50);
    const res = await app.request(
      new Request("https://example.com/upload", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("カスタムサイズ: 100バイトを超えると 413 を返す", async () => {
    const app = buildApp(100);
    const body = "a".repeat(101);
    const res = await app.request(
      new Request("https://example.com/upload", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
      }),
    );
    expect(res.status).toBe(413);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("GETリクエストはボディサイズ制限の対象外", async () => {
    const getApp = new Hono();
    getApp.use("*", bodyLimitMiddleware(10));
    getApp.get("/test", (c) => c.json({ ok: true }));
    const res = await getApp.request("https://example.com/test");
    expect(res.status).toBe(200);
  });

  it("空ボディは通過する", async () => {
    const app = buildApp(100);
    const res = await app.request(
      new Request("https://example.com/upload", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "",
      }),
    );
    expect(res.status).toBe(200);
  });
});
