import { Hono } from "hono";
import type { IdpEnv } from "@0g0-id/shared";

import { INTERNAL_OPENAPI } from "./openapi/internal-spec";
import { EXTERNAL_OPENAPI } from "./openapi/external-spec";
import { DOCS_CSP, scalarHtml } from "./openapi/scalar";
import { openApiToMarkdown, type OpenApiSpec } from "./openapi/markdown";

const app = new Hono<{ Bindings: IdpEnv }>();

// ─── ルート定義 ────────────────────────────────────────────────────
// IdP 開発者向け: 全API（内部利用）
app.get("/", (c) => {
  c.header("Content-Security-Policy", DOCS_CSP);
  return c.html(
    scalarHtml("/docs/openapi.json", "0g0 ID API — IdP 開発者向け", "/docs/openapi.md"),
  );
});
// 内部向け仕様は開発者ネットワーク内での参照を想定。本番では Cloudflare Access 等で保護すること
app.get("/openapi.json", (c) => c.json(INTERNAL_OPENAPI));
// AI・CLIツール向けMarkdown版（JSなしで参照可能）
app.get("/openapi.md", (c) => {
  c.header("Content-Type", "text/markdown; charset=utf-8");
  return c.body(openApiToMarkdown(INTERNAL_OPENAPI as OpenApiSpec, "https://id.0g0.xyz/docs"));
});

// 外部連携サービス向け: 外部API + 連携フロー
app.get("/external", (c) => {
  c.header("Content-Security-Policy", DOCS_CSP);
  return c.html(
    scalarHtml(
      "/docs/external/openapi.json",
      "0g0 ID API — 外部連携サービス向け",
      "/docs/external.md",
    ),
  );
});
app.get("/external/openapi.json", (c) => c.json(EXTERNAL_OPENAPI));
// AI・CLIツール向けMarkdown版（JSなしで参照可能）
app.get("/external.md", (c) => {
  c.header("Content-Type", "text/markdown; charset=utf-8");
  return c.body(
    openApiToMarkdown(EXTERNAL_OPENAPI as OpenApiSpec, "https://id.0g0.xyz/docs/external"),
  );
});

export default app;
