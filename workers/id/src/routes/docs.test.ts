import { describe, it, expect } from "vite-plus/test";
import { Hono } from "hono";
import type { IdpEnv } from "@0g0-id/shared";

import docsRoutes from "./docs";

const baseUrl = "https://id.0g0.xyz";

function buildApp() {
  const app = new Hono<{ Bindings: IdpEnv }>();
  app.route("/docs", docsRoutes);
  return app;
}

describe("GET /docs — ドキュメントルート", () => {
  const app = buildApp();

  describe("GET / — IdP開発者向けドキュメント", () => {
    it("200を返す", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs`));
      expect(res.status).toBe(200);
    });

    it("HTMLコンテンツを返す", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs`));
      const contentType = res.headers.get("Content-Type");
      expect(contentType).toContain("text/html");
    });

    it("APIタイトルがHTMLに含まれる", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs`));
      const html = await res.text();
      expect(html).toContain("0g0 ID API");
    });

    it("ドキュメント用CSPが設定される（CDNスクリプトを許可）", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs`));
      const csp = res.headers.get("Content-Security-Policy");
      expect(csp).toContain("cdn.jsdelivr.net");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
    });
  });

  describe("GET /openapi.json — 内部API仕様", () => {
    it("200を返す", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/openapi.json`));
      expect(res.status).toBe(200);
    });

    it("JSONコンテンツを返す", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/openapi.json`));
      const contentType = res.headers.get("Content-Type");
      expect(contentType).toContain("application/json");
    });

    it("OpenAPI仕様のopenapi・info・pathsフィールドを含む", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/openapi.json`));
      const body = await res.json<{ openapi: string; info: { title: string }; paths: unknown }>();
      expect(body.openapi).toMatch(/^3\./);
      expect(body.info.title).toBeTruthy();
      expect(body.paths).toBeTruthy();
    });
  });

  describe("GET /external — 外部連携サービス向けドキュメント", () => {
    it("200を返す", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external`));
      expect(res.status).toBe(200);
    });

    it("HTMLコンテンツを返す", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external`));
      const contentType = res.headers.get("Content-Type");
      expect(contentType).toContain("text/html");
    });

    it("外部連携向けタイトルがHTMLに含まれる", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external`));
      const html = await res.text();
      expect(html).toContain("0g0 ID API");
    });

    it("ドキュメント用CSPが設定される（CDNスクリプトを許可）", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external`));
      const csp = res.headers.get("Content-Security-Policy");
      expect(csp).toContain("cdn.jsdelivr.net");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
    });
  });

  describe("GET /external/openapi.json — 外部API仕様", () => {
    it("200を返す", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external/openapi.json`));
      expect(res.status).toBe(200);
    });

    it("JSONコンテンツを返す", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external/openapi.json`));
      const contentType = res.headers.get("Content-Type");
      expect(contentType).toContain("application/json");
    });

    it("OpenAPI仕様のopenapi・info・pathsフィールドを含む", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external/openapi.json`));
      const body = await res.json<{ openapi: string; info: { title: string }; paths: unknown }>();
      expect(body.openapi).toMatch(/^3\./);
      expect(body.info.title).toBeTruthy();
      expect(body.paths).toBeTruthy();
    });

    it("外部向け仕様に /auth/login エンドポイントが含まれる", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external/openapi.json`));
      const body = await res.json<{ paths: Record<string, unknown> }>();
      expect(body.paths).toHaveProperty("/auth/login");
    });

    it("/auth/login に client_id・code_challenge パラメータが定義される", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external/openapi.json`));
      const body = await res.json<{
        paths: { "/auth/login": { get: { parameters: { name: string }[] } } };
      }>();
      const params = body.paths["/auth/login"].get.parameters.map((p) => p.name);
      expect(params).toContain("client_id");
      expect(params).toContain("redirect_to");
      expect(params).toContain("state");
      expect(params).toContain("code_challenge");
      expect(params).toContain("code_challenge_method");
      expect(params).toContain("provider");
    });
  });

  describe("GET /external.md — 外部API仕様 Markdown版（AI/CLI向け）", () => {
    it("200を返す", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external.md`));
      expect(res.status).toBe(200);
    });

    it("text/markdownコンテンツを返す", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external.md`));
      const contentType = res.headers.get("Content-Type");
      expect(contentType).toContain("text/markdown");
    });

    it("タイトルとエンドポイント情報が含まれる", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external.md`));
      const text = await res.text();
      expect(text).toContain("# 0g0 ID");
      expect(text).toContain("/auth/login");
      expect(text).toContain("/api/external/users");
    });

    it("パラメータテーブルが含まれる", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/external.md`));
      const text = await res.text();
      expect(text).toContain("| 名前 |");
      expect(text).toContain("client_id");
    });
  });

  describe("GET /openapi.md — 内部API仕様 Markdown版（AI/CLI向け）", () => {
    it("200を返す", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/openapi.md`));
      expect(res.status).toBe(200);
    });

    it("text/markdownコンテンツを返す", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/openapi.md`));
      const contentType = res.headers.get("Content-Type");
      expect(contentType).toContain("text/markdown");
    });

    it("内部APIのエンドポイント情報が含まれる", async () => {
      const res = await app.request(new Request(`${baseUrl}/docs/openapi.md`));
      const text = await res.text();
      expect(text).toContain("# 0g0 ID");
      expect(text).toContain("/api/users");
    });
  });
});
