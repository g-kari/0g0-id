import { Hono } from "hono";
import { createLogger, logUpstreamDeprecation, restErrorBody } from "@0g0-id/shared";
import type { BffEnv, OAuthProvider } from "@0g0-id/shared";

const providerStatusLogger = createLogger("user-provider-status");

const app = new Hono<{ Bindings: BffEnv }>();

// GET /auth/providers/status — 設定済みプロバイダー一覧（真偽値のみ）
// IdP の GET /auth/providers を中継する。フロントが未設定プロバイダーの
// ログインボタンを表示しないための公開情報で、資格情報は含まない。
// 取得に失敗した場合は 502 を返し、フロント側は既存プロバイダーのみ表示する。
app.get("/providers/status", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const res = await c.env.IDP.fetch(new Request(`${c.env.IDP_ORIGIN}/auth/providers`));
    logUpstreamDeprecation(res, { method: "GET", path: "/auth/providers" }, providerStatusLogger);
    if (!res.ok) {
      providerStatusLogger.error("[providers/status] IdP returned an error", {
        status: res.status,
      });
      return c.json(restErrorBody("UPSTREAM_ERROR", "Failed to load provider settings"), 502);
    }
    const body = await res.json<{ data: Record<OAuthProvider, boolean> }>();
    return c.json(body.data);
  } catch (err) {
    providerStatusLogger.error("[providers/status] Failed to reach IdP", err);
    return c.json(restErrorBody("UPSTREAM_ERROR", "Failed to load provider settings"), 502);
  }
});

export default app;
