import { describe, it, expect } from "vite-plus/test";
import { Hono } from "hono";
import { bffCorsMiddleware } from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";

const testEnv = { SELF_ORIGIN: "https://admin.0g0.xyz" } as unknown as BffEnv;

function buildApp() {
  const app = new Hono<{ Bindings: BffEnv }>();
  app.use("/api/*", bffCorsMiddleware);
  app.get("/api/test", (c) => c.json({ ok: true }));
  app.post("/api/test", (c) => c.json({ ok: true }));
  return app;
}

describe("bffCorsMiddleware", () => {
  const app = buildApp();
  const baseUrl = "https://admin.0g0.xyz";

  it("Originなしのリクエスト → 200を返す", async () => {
    const res = await app.request(`${baseUrl}/api/test`, undefined, testEnv);
    expect(res.status).toBe(200);
  });

  it("同一オリジンからのGETリクエスト → Access-Control-Allow-Originが設定される", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, {
        headers: { Origin: baseUrl },
      }),
      undefined,
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(baseUrl);
  });

  it("Access-Control-Allow-Credentials が true になる", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, {
        headers: { Origin: baseUrl },
      }),
      undefined,
      testEnv,
    );
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("OPTIONSプリフライト → 204を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, {
        method: "OPTIONS",
        headers: {
          Origin: baseUrl,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type",
        },
      }),
      undefined,
      testEnv,
    );
    expect(res.status).toBe(204);
    const allowMethods = res.headers.get("Access-Control-Allow-Methods") ?? "";
    expect(allowMethods).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("許可メソッド（GET, POST, PATCH, DELETE）がプリフライトで返される", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, {
        method: "OPTIONS",
        headers: {
          Origin: baseUrl,
          "Access-Control-Request-Method": "DELETE",
        },
      }),
      undefined,
      testEnv,
    );
    const allowMethods = res.headers.get("Access-Control-Allow-Methods") ?? "";
    expect(allowMethods).toContain("GET");
    expect(allowMethods).toContain("POST");
    expect(allowMethods).toContain("DELETE");
  });

  it("Content-Typeヘッダーが許可される", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/api/test`, {
        method: "OPTIONS",
        headers: {
          Origin: baseUrl,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type",
        },
      }),
      undefined,
      testEnv,
    );
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowHeaders).toContain("Content-Type");
  });
});
