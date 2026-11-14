import { describe, it, expect } from "vite-plus/test";
import { Hono } from "hono";

import oauthRoutes from "./oauth";

const baseUrl = "https://user.0g0.xyz";

function buildApp() {
  const app = new Hono<{ Bindings: { IDP_ORIGIN: string } }>();
  app.route("/", oauthRoutes);
  return {
    request: (path: string, init?: RequestInit) => {
      const req = new Request(`${baseUrl}${path}`, init);
      return app.request(req, undefined, {
        IDP_ORIGIN: "https://id.0g0.xyz",
      });
    },
  };
}

const REQUIRED_PARAMS =
  "?client_id=client123&redirect_uri=https://app.example.com/callback&state=abc&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("OAuth ログインページ — GET /login", () => {
  describe("正常系", () => {
    it("必須パラメータがすべて揃っている場合に200を返す", async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      expect(res.status).toBe(200);
    });

    it("レスポンスがHTMLである", async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    });

    it("CSPヘッダーに style-src self が含まれる（外部CSS読み込み許可）", async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      const csp = res.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("style-src 'self'");
    });

    it("CSPヘッダーに img-src self が含まれる（ファビコン読み込み許可）", async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      const csp = res.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("img-src 'self'");
    });

    it("CSPヘッダーに script-src none が明示されている", async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      const csp = res.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("script-src 'none'");
    });

    it("CSPヘッダーに unsafe-inline が含まれない", async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      const csp = res.headers.get("Content-Security-Policy") ?? "";
      expect(csp).not.toContain("'unsafe-inline'");
    });

    it("CSPヘッダーに frame-ancestors none が含まれる", async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      const csp = res.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it("HTMLにIdP /auth/login へのリンクが含まれる", async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      const html = await res.text();
      expect(html).toContain("https://id.0g0.xyz/auth/login");
    });

    it("全プロバイダーのボタンが含まれる", async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}`);
      const html = await res.text();
      expect(html).toContain("provider=google");
      expect(html).toContain("provider=line");
      expect(html).toContain("provider=twitch");
      expect(html).toContain("provider=github");
      expect(html).toContain("provider=x");
    });

    it("nonce パラメータがリンクに引き継がれる", async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}&nonce=test-nonce-value`);
      const html = await res.text();
      expect(html).toContain("nonce=test-nonce-value");
    });

    it("scope パラメータがリンクに引き継がれる", async () => {
      const app = buildApp();
      const res = await app.request(`/login${REQUIRED_PARAMS}&scope=openid+profile`);
      const html = await res.text();
      expect(html).toContain("scope=");
    });
  });

  describe("バリデーション（パラメータ不足）", () => {
    it("client_id が未指定の場合はルートへリダイレクト", async () => {
      const app = buildApp();
      const res = await app.request(
        "/login?redirect_uri=https://app.example.com/callback&state=abc&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
    });

    it("redirect_uri が未指定の場合はルートへリダイレクト", async () => {
      const app = buildApp();
      const res = await app.request(
        "/login?client_id=client123&state=abc&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
    });

    it("state が未指定の場合はルートへリダイレクト", async () => {
      const app = buildApp();
      const res = await app.request(
        "/login?client_id=client123&redirect_uri=https://app.example.com/callback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
    });

    it("code_challenge が未指定の場合はルートへリダイレクト", async () => {
      const app = buildApp();
      const res = await app.request(
        "/login?client_id=client123&redirect_uri=https://app.example.com/callback&state=abc",
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
    });
  });

  describe("バリデーション — パラメータ長上限", () => {
    it("state が1025文字の場合は400を返す", async () => {
      const app = buildApp();
      const longState = "a".repeat(1025);
      const res = await app.request(
        `/login?client_id=client123&redirect_uri=https://app.example.com/callback&state=${longState}&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`,
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("state");
    });

    it("state が1024文字ちょうどの場合は正常（200）", async () => {
      const app = buildApp();
      const maxState = "a".repeat(1024);
      const res = await app.request(
        `/login?client_id=client123&redirect_uri=https://app.example.com/callback&state=${maxState}&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`,
      );
      expect(res.status).toBe(200);
    });

    it("nonce が129文字の場合は400を返す", async () => {
      const app = buildApp();
      const longNonce = "a".repeat(129);
      const res = await app.request(`/login${REQUIRED_PARAMS}&nonce=${longNonce}`);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("nonce");
    });

    it("nonce が128文字ちょうどの場合は正常（200）", async () => {
      const app = buildApp();
      const maxNonce = "a".repeat(128);
      const res = await app.request(`/login${REQUIRED_PARAMS}&nonce=${maxNonce}`);
      expect(res.status).toBe(200);
    });
  });

  describe("セキュリティ — HTMLエスケープ", () => {
    it("redirect_uri の特殊文字がHTMLにそのまま出力されない（URLエンコードされる）", async () => {
      const app = buildApp();
      const malicious = "https://app.example.com/callback?foo=<script>alert(1)</script>";
      const res = await app.request(
        `/login?client_id=client123&redirect_uri=${encodeURIComponent(malicious)}&state=abc&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`,
      );
      const html = await res.text();
      // URL APIが <> を %3C%3E にエンコード、escapeHtmlが & を &amp; に変換するため
      // リテラルの <script> タグはHTMLに含まれない
      expect(html).not.toContain("<script>");
      expect(html).toContain("%3Cscript%3E");
    });

    it("state の特殊文字がHTMLエスケープされる", async () => {
      const app = buildApp();
      const maliciousState = '"><img src=x onerror=alert(1)>';
      const res = await app.request(
        `/login?client_id=client123&redirect_uri=https://app.example.com/callback&state=${encodeURIComponent(maliciousState)}&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`,
      );
      const html = await res.text();
      expect(html).not.toContain("<img src=x onerror=alert(1)>");
    });
  });
});

describe("OAuth ログインページ — 未設定プロバイダーのボタン非表示", () => {
  function buildAppWithIdp(idpFetch: (req: Request) => Promise<Response>) {
    const app = new Hono<{ Bindings: { IDP_ORIGIN: string; IDP: Fetcher } }>();
    app.route("/", oauthRoutes);
    const idp = { fetch: idpFetch } as unknown as Fetcher;
    return {
      request: (path: string, init?: RequestInit) => {
        const req = new Request(`${baseUrl}${path}`, init);
        return app.request(req, undefined, {
          IDP_ORIGIN: "https://id.0g0.xyz",
          IDP: idp,
        });
      },
    };
  }

  it.each([{}, { discord: false, steam: false }, { discord: "true", steam: 1 }, null, []])(
    "new providers require explicit true: %j",
    async (data) => {
      const app = buildAppWithIdp(async () => Response.json({ data }));
      const html = await (await app.request(`/login${REQUIRED_PARAMS}`)).text();
      expect(html).not.toContain("Discordでサインイン");
      expect(html).not.toContain("Steamでサインイン");
    },
  );

  it("configured new providers preserve OAuth request parameters", async () => {
    const app = buildAppWithIdp(async () =>
      Response.json({ data: { discord: true, steam: true } }),
    );
    const html = await (
      await app.request(
        `/login${REQUIRED_PARAMS}&nonce=test-nonce&resource=https%3A%2F%2Fapi.example.com`,
      )
    ).text();
    for (const provider of ["discord", "steam"]) {
      const href = html.match(new RegExp(`href="([^"]*provider=${provider}[^"]*)"`))?.[1];
      expect(href).toBeDefined();
      const url = new URL(href!.replaceAll("&amp;", "&"));
      const expected = new URLSearchParams(REQUIRED_PARAMS);
      expect(url.searchParams.get("state")).toBe(expected.get("state"));
      expect(url.searchParams.get("code_challenge")).toBe(expected.get("code_challenge"));
      expect(url.searchParams.get("nonce")).toBe("test-nonce");
      expect(url.searchParams.get("resource")).toBe("https://api.example.com");
    }
  });

  it("malformed discovery never enables new providers", async () => {
    const app = buildAppWithIdp(async () => new Response("not json"));
    const html = await (await app.request(`/login${REQUIRED_PARAMS}`)).text();
    expect(html).not.toContain("Discordでサインイン");
    expect(html).not.toContain("Steamでサインイン");
  });

  it("IdP で未設定のプロバイダーはボタンが表示されない", async () => {
    const app = buildAppWithIdp(async () =>
      Response.json({
        data: { google: true, line: false, twitch: true, github: true, x: false },
      }),
    );
    const res = await app.request(`/login${REQUIRED_PARAMS}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Googleでサインイン");
    expect(html).toContain("Twitchでサインイン");
    expect(html).toContain("GitHubでサインイン");
    expect(html).not.toContain("LINEでサインイン");
    expect(html).not.toContain("X（Twitter）でサインイン");
  });

  it("IdP がエラーを返した場合は全ボタンが表示される（フォールバック）", async () => {
    const app = buildAppWithIdp(async () => new Response("error", { status: 500 }));
    const res = await app.request(`/login${REQUIRED_PARAMS}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Googleでサインイン");
    expect(html).toContain("LINEでサインイン");
    expect(html).toContain("Twitchでサインイン");
    expect(html).toContain("GitHubでサインイン");
    expect(html).toContain("X（Twitter）でサインイン");
    expect(html).not.toContain("Discordでサインイン");
    expect(html).not.toContain("Steamでサインイン");
  });

  it("IdP への接続に失敗した場合は全ボタンが表示される（フォールバック）", async () => {
    const app = buildAppWithIdp(async () => {
      throw new Error("network error");
    });
    const res = await app.request(`/login${REQUIRED_PARAMS}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("LINEでサインイン");
    expect(html).toContain("X（Twitter）でサインイン");
    expect(html).not.toContain("Discordでサインイン");
    expect(html).not.toContain("Steamでサインイン");
  });
});

describe("OAuth ログインページ — /style.css の配信", () => {
  // このページのスタイルシートは frontend/public/style.css が正本で、
  // wrangler.toml の run_worker_first 除外により Assets から配信される。
  // 実配信の確認は scripts/ci-app-smoke.ts 側で行う。
  it("HTMLが /style.css を参照する", async () => {
    const app = buildApp();
    const res = await app.request(`/login${REQUIRED_PARAMS}`);
    const html = await res.text();
    expect(html).toContain('<link rel="stylesheet" href="/style.css">');
  });
});
