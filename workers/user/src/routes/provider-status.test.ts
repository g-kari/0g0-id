import { describe, it, expect } from "vite-plus/test";
import { Hono } from "hono";

import providerStatusRoutes from "./provider-status";

const baseUrl = "https://user.0g0.xyz";

function buildApp(idpFetch: (req: Request) => Promise<Response>) {
  const app = new Hono<{ Bindings: { IDP_ORIGIN: string; IDP: Fetcher } }>();
  app.route("/auth", providerStatusRoutes);
  const idp = { fetch: idpFetch } as unknown as Fetcher;
  return {
    request: (path: string) =>
      app.request(new Request(`${baseUrl}${path}`), undefined, {
        IDP_ORIGIN: "https://id.0g0.xyz",
        IDP: idp,
      }),
  };
}

describe("GET /auth/providers/status — 設定済みプロバイダー一覧の中継", () => {
  it("IdP の /auth/providers の data をそのまま返す", async () => {
    const configured = { google: true, line: false, twitch: true, github: false, x: false };
    const app = buildApp(async (req) => {
      expect(req.url).toBe("https://id.0g0.xyz/auth/providers");
      return Response.json({ data: configured });
    });
    const res = await app.request("/auth/providers/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(configured);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("IdP がエラーを返した場合は 502", async () => {
    const app = buildApp(async () => new Response("error", { status: 500 }));
    const res = await app.request("/auth/providers/status");
    expect(res.status).toBe(502);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UPSTREAM_ERROR");
  });

  it("IdP への接続に失敗した場合は 502", async () => {
    const app = buildApp(async () => {
      throw new Error("network error");
    });
    const res = await app.request("/auth/providers/status");
    expect(res.status).toBe(502);
  });
});
