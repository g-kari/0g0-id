import { describe, it, expect } from "vite-plus/test";
import { Hono } from "hono";
import { bffCorsMiddleware, bffCsrfMiddleware } from "./bff";
import type { BffEnv } from "../types";

const mockEnv = {
  SELF_ORIGIN: "https://user.0g0.xyz",
} as unknown as BffEnv;

function buildCsrfApp() {
  const app = new Hono<{ Bindings: BffEnv }>();
  app.use("*", bffCsrfMiddleware);
  app.post("/api/test", (c) => c.json({ ok: true }));
  return app;
}

function buildCorsApp() {
  const app = new Hono<{ Bindings: BffEnv }>();
  app.use("*", bffCorsMiddleware);
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

describe("bffCsrfMiddleware", () => {
  it("Originヘッダーが一致 → 通過する", async () => {
    const res = await buildCsrfApp().request(
      new Request("https://user.0g0.xyz/api/test", {
        method: "POST",
        headers: { Origin: "https://user.0g0.xyz" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
  });

  it("Originヘッダーなし → 403を返す", async () => {
    const res = await buildCsrfApp().request(
      new Request("https://user.0g0.xyz/api/test", { method: "POST" }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("外部オリジン → 403を返す", async () => {
    const res = await buildCsrfApp().request(
      new Request("https://user.0g0.xyz/api/test", {
        method: "POST",
        headers: { Origin: "https://evil.example.com" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("不正な形式のOriginヘッダー → 403を返す", async () => {
    const res = await buildCsrfApp().request(
      new Request("https://user.0g0.xyz/api/test", {
        method: "POST",
        headers: { Origin: "not-a-url" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("RefererヘッダーのみでOriginなし → 403を返す（CSRFバイパス不可）", async () => {
    const res = await buildCsrfApp().request(
      new Request("https://user.0g0.xyz/api/test", {
        method: "POST",
        headers: { Referer: "https://user.0g0.xyz/page" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });
});

describe("bffCorsMiddleware", () => {
  it("SELF_ORIGINからのリクエスト → CORSヘッダーが設定される", async () => {
    const res = await buildCorsApp().request(
      new Request("https://user.0g0.xyz/test", {
        headers: { Origin: "https://user.0g0.xyz" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://user.0g0.xyz");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("OPTIONSプリフライトリクエスト → 204を返す", async () => {
    const res = await buildCorsApp().request(
      new Request("https://user.0g0.xyz/test", {
        method: "OPTIONS",
        headers: {
          Origin: "https://user.0g0.xyz",
          "Access-Control-Request-Method": "POST",
        },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(204);
  });
});
