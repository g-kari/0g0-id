import { describe, it, expect, vi } from "vite-plus/test";
import { Hono } from "hono";
import type { IdpEnv } from "@0g0-id/shared";

vi.mock("../utils/service-auth", () => ({
  authenticateService: vi.fn(),
}));

import { serviceBindingMiddleware } from "./service-binding";
import { authenticateService } from "../utils/service-auth";

function buildApp(env: Partial<IdpEnv>) {
  const app = new Hono<{ Bindings: typeof env }>();
  app.use("/auth/*", serviceBindingMiddleware);
  app.post("/auth/exchange", (c) => c.json({ ok: true }));
  app.post("/auth/refresh", (c) => c.json({ ok: true }));
  return { app, env };
}

const baseUrl = "https://id.0g0.xyz";
const SECRET = "test-internal-secret-12345";

describe("serviceBindingMiddleware", () => {
  describe("INTERNAL_SERVICE_SECRET が未設定の場合", () => {
    it("ヘッダーなしでもリクエストを通過させる", async () => {
      const { app, env } = buildApp({});
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, { method: "POST" }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
    });
  });

  describe("INTERNAL_SERVICE_SECRET が設定されている場合", () => {
    it("正しい X-Internal-Secret ヘッダーで通過する", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": SECRET },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
    });

    it("不正な X-Internal-Secret ヘッダーで403を返す", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { "X-Internal-Secret": "wrong-secret" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("ヘッダーなしで403���返す", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, { method: "POST" }),
        undefined,
        env,
      );
      expect(res.status).toBe(403);
    });

    it("有効な Authorization: Basic ヘッダーで通過する（サービスOAuth）", async () => {
      vi.mocked(authenticateService).mockResolvedValue({ id: "service-1" } as never);
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET, DB: {} as D1Database });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { Authorization: "Basic dGVzdDp0ZXN0" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(200);
      expect(authenticateService).toHaveBeenCalled();
    });

    it("無効な Authorization: Basic ヘッダーでは403を返す", async () => {
      vi.mocked(authenticateService).mockResolvedValue(null);
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET, DB: {} as D1Database });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { Authorization: "Basic aW52YWxpZDppbnZhbGlk" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("authenticateService がエラーを投げたら500を返す", async () => {
      vi.mocked(authenticateService).mockRejectedValue(new Error("DB error"));
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET, DB: {} as D1Database });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { Authorization: "Basic dGVzdDp0ZXN0" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(500);
      const body = await res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });

    it("Authorization: Bearer ヘッダーでは通過しない", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const res = await app.request(
        new Request(`${baseUrl}/auth/exchange`, {
          method: "POST",
          headers: { Authorization: "Bearer some-token" },
        }),
        undefined,
        env,
      );
      expect(res.status).toBe(403);
    });

    it("/auth/refresh にも適用される", async () => {
      const { app, env } = buildApp({ INTERNAL_SERVICE_SECRET: SECRET });
      const resBlocked = await app.request(
        new Request(`${baseUrl}/auth/refresh`, { method: "POST" }),
        undefined,
        env,
      );
      expect(resBlocked.status).toBe(403);

      const resAllowed = await app.request(
        new Request(`${baseUrl}/auth/refresh`, {
          method: "POST",
          headers: { "X-Internal-Secret": SECRET },
        }),
        undefined,
        env,
      );
      expect(resAllowed.status).toBe(200);
    });
  });
});
