import { Hono } from "hono";
import { fetchWithAuth, proxyResponse } from "@0g0-id/shared";
import type { BffEnv } from "@0g0-id/shared";
import { SESSION_COOKIE } from "./auth";

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/me/bff-sessions — 自分のBFFセッション一覧（DBSC バインド状態を含む）
app.get("/", async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/users/me/bff-sessions`,
  );
  return proxyResponse(res);
});

export default app;
