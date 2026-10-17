import { describe, it, expect } from "vite-plus/test";
import { Hono } from "hono";
import { bffCsrfMiddleware } from "../middleware/bff";
import type { BffEnv } from "../types";

export interface BffCsrfTestConfig {
  origin: string;
  label: string;
  otherBffOrigin: string;
  otherBffLabel: string;
  refererPath: string;
}

export function createBffCsrfTestSuite(config: BffCsrfTestConfig): void {
  const { origin, label, otherBffOrigin, otherBffLabel, refererPath } = config;
  const testEnv = { SELF_ORIGIN: origin } as unknown as BffEnv;

  function buildApp() {
    const app = new Hono<{ Bindings: BffEnv }>();
    app.use("/api/*", bffCsrfMiddleware);
    app.get("/api/test", (c) => c.json({ ok: true }));
    app.post("/api/test", (c) => c.json({ ok: true }));
    return app;
  }

  describe("bffCsrfMiddleware", () => {
    const app = buildApp();

    describe("Originヘッダーなし", () => {
      it("GETリクエストでOriginなし → 安全メソッドのためCSRFスキップで200を返す", async () => {
        const req = new Request(`${origin}/api/test`);
        const res = await app.request(req, undefined, testEnv);
        expect(res.status).toBe(200);
      });

      it("POSTリクエストでOriginなし → 403を返す", async () => {
        const req = new Request(`${origin}/api/test`, { method: "POST" });
        const res = await app.request(req, undefined, testEnv);
        expect(res.status).toBe(403);
      });
    });

    describe(`正常なOriginヘッダー（${label}ドメイン）`, () => {
      it(`GETリクエストでOrigin=${label}ドメイン → 200を返す`, async () => {
        const req = new Request(`${origin}/api/test`, {
          headers: { Origin: origin },
        });
        const res = await app.request(req, undefined, testEnv);
        expect(res.status).toBe(200);
      });

      it(`POSTリクエストでOrigin=${label}ドメイン → 200を返す`, async () => {
        const req = new Request(`${origin}/api/test`, {
          method: "POST",
          headers: { Origin: origin },
        });
        const res = await app.request(req, undefined, testEnv);
        expect(res.status).toBe(200);
      });

      it("Refererのみ（Originなし）のGETは安全メソッドのためCSRFスキップで200を返す", async () => {
        const req = new Request(`${origin}/api/test`, {
          headers: { Referer: `${origin}/${refererPath}` },
        });
        const res = await app.request(req, undefined, testEnv);
        expect(res.status).toBe(200);
      });
    });

    describe("外部サービスからのアクセス", () => {
      it("外部ドメインからのOrigin（POST）→ 403を返す", async () => {
        const req = new Request(`${origin}/api/test`, {
          method: "POST",
          headers: { Origin: "https://external-service.example.com" },
        });
        const res = await app.request(req, undefined, testEnv);
        expect(res.status).toBe(403);
        const body = await res.json<{ error: { code: string } }>();
        expect(body.error.code).toBe("FORBIDDEN");
      });

      it(`idドメインからのOrigin（POST・内部サービスでも${label}APIは拒否）→ 403を返す`, async () => {
        const req = new Request(`${origin}/api/test`, {
          method: "POST",
          headers: { Origin: "https://id.0g0.xyz" },
        });
        const res = await app.request(req, undefined, testEnv);
        expect(res.status).toBe(403);
      });

      it(`${otherBffLabel}ドメインからのOrigin（POST）→ 403を返す`, async () => {
        const req = new Request(`${origin}/api/test`, {
          method: "POST",
          headers: { Origin: otherBffOrigin },
        });
        const res = await app.request(req, undefined, testEnv);
        expect(res.status).toBe(403);
      });

      it("不正な形式のOriginヘッダー（POST）→ 403を返す", async () => {
        const req = new Request(`${origin}/api/test`, {
          method: "POST",
          headers: { Origin: "not-a-valid-url" },
        });
        const res = await app.request(req, undefined, testEnv);
        expect(res.status).toBe(403);
      });
    });

    describe("/auth/* ルートはCSRF保護対象外", () => {
      it("authルートはOriginなしでもアクセス可能", async () => {
        const authApp = new Hono<{ Bindings: BffEnv }>();
        authApp.use("/api/*", bffCsrfMiddleware);
        authApp.get("/auth/login", (c) => c.json({ ok: true }));

        const req = new Request(`${origin}/auth/login`);
        const res = await authApp.request(req, undefined, testEnv);
        expect(res.status).toBe(200);
      });
    });
  });
}
