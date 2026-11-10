import { describe, it, expect } from "vite-plus/test";
import { Hono } from "hono";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";
import type { IdpEnv } from "@0g0-id/shared";
import { handleProviders } from "./providers";

function buildApp(env: IdpEnv) {
  const app = new Hono<{ Bindings: IdpEnv }>();
  app.get("/auth/providers", handleProviders);
  return {
    request: () => app.request("https://id.0g0.xyz/auth/providers", undefined, env),
  };
}

describe("GET /auth/providers — 設定済みプロバイダー一覧", () => {
  it("任意プロバイダーの資格情報が無い環境では google のみ true", async () => {
    const res = await buildApp(createMockIdpEnv()).request();
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Record<string, boolean> }>();
    expect(body.data).toEqual({
      google: true,
      line: false,
      twitch: false,
      github: false,
      x: false,
      discord: false,
      steam: false,
    });
  });

  it("LINE の資格情報がある環境では line も true", async () => {
    const env = createMockIdpEnv({
      LINE_CLIENT_ID: "line-client-id",
      LINE_CLIENT_SECRET: "line-client-secret",
    });
    const res = await buildApp(env).request();
    const body = await res.json<{ data: Record<string, boolean> }>();
    expect(body.data.line).toBe(true);
    expect(body.data.twitch).toBe(false);
  });

  it("全プロバイダーの資格情報がある環境では全て true", async () => {
    const env = createMockIdpEnv({
      LINE_CLIENT_ID: "line-client-id",
      LINE_CLIENT_SECRET: "line-client-secret",
      TWITCH_CLIENT_ID: "twitch-client-id",
      TWITCH_CLIENT_SECRET: "twitch-client-secret",
      GITHUB_CLIENT_ID: "github-client-id",
      GITHUB_CLIENT_SECRET: "github-client-secret",
      X_CLIENT_ID: "x-client-id",
      X_CLIENT_SECRET: "x-client-secret",
    });
    const res = await buildApp(env).request();
    const body = await res.json<{ data: Record<string, boolean> }>();
    expect(body.data).toEqual({
      google: true,
      line: true,
      twitch: true,
      github: true,
      x: true,
      discord: false,
      steam: false,
    });
  });

  it("client_id だけでは未設定扱い（secret も必要）", async () => {
    const env = createMockIdpEnv({ TWITCH_CLIENT_ID: "twitch-client-id" });
    const res = await buildApp(env).request();
    const body = await res.json<{ data: Record<string, boolean> }>();
    expect(body.data.twitch).toBe(false);
  });

  it("資格情報の値そのものはレスポンスに含まれない", async () => {
    const env = createMockIdpEnv({
      LINE_CLIENT_ID: "line-client-id",
      LINE_CLIENT_SECRET: "line-client-secret",
    });
    const res = await buildApp(env).request();
    const text = await res.text();
    expect(text).not.toContain("line-client-id");
    expect(text).not.toContain("line-client-secret");
  });

  it("Cache-Control: no-store を返す", async () => {
    const res = await buildApp(createMockIdpEnv()).request();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
