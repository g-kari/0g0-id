import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";
import type { TokenPayload } from "@0g0-id/shared";

// --- モック定義 ---
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...original,
    signCookie: vi.fn(),
  };
});

import { signCookie } from "@0g0-id/shared";
import { handleLinkIntent } from "./link-intent";

// --- テスト用定数 ---
const mockEnv = createMockIdpEnv();

const mockTokenUser: TokenPayload = {
  iss: "https://id.0g0.xyz",
  sub: "user-123",
  aud: "https://id.0g0.xyz",
  exp: Math.floor(Date.now() / 1000) + 900,
  iat: Math.floor(Date.now() / 1000),
  jti: "test-jti",
  kid: "test-kid",
  email: "user@example.com",
  role: "user",
};

// --- ヘルパー ---
function buildApp() {
  const app = new Hono<{
    Bindings: ReturnType<typeof createMockIdpEnv>;
    Variables: { user: TokenPayload };
  }>();
  // 認証ミドルウェアのモック
  app.use("/auth/link-intent", async (c, next) => {
    c.set("user", mockTokenUser);
    await next();
  });
  app.post("/auth/link-intent", handleLinkIntent);
  return app;
}

function makeRequest() {
  const app = buildApp();
  return app.request(
    new Request("https://id.0g0.xyz/auth/link-intent", {
      method: "POST",
    }),
    undefined,
    mockEnv,
  );
}

// --- テスト ---
describe("POST /auth/link-intent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(signCookie).mockResolvedValue("signed-link-token");
  });

  // =====================
  // 正常系
  // =====================
  describe("正常系", () => {
    it("認証済みユーザーで link_token を返す", async () => {
      const res = await makeRequest();
      expect(res.status).toBe(200);
      const body = await res.json<{ data: { link_token: string } }>();
      expect(body.data.link_token).toBe("signed-link-token");
    });

    it("signCookie に正しいペイロードが渡される", async () => {
      await makeRequest();

      expect(signCookie).toHaveBeenCalledOnce();
      const [payloadArg] = vi.mocked(signCookie).mock.calls[0];
      const parsed = JSON.parse(payloadArg) as {
        purpose: string;
        sub: string;
        jti: string;
        exp: number;
      };

      expect(parsed.purpose).toBe("link");
      expect(parsed.sub).toBe("user-123");
      expect(parsed.jti).toBeDefined();
      expect(typeof parsed.jti).toBe("string");
      expect(parsed.jti.length).toBeGreaterThan(0);
      // exp は未来の値（現在時刻 + 約2分）
      expect(parsed.exp).toBeGreaterThan(Date.now());
      expect(parsed.exp).toBeLessThanOrEqual(Date.now() + 2 * 60 * 1000 + 1000);
    });

    it("signCookie に COOKIE_SECRET が渡される", async () => {
      await makeRequest();

      expect(signCookie).toHaveBeenCalledOnce();
      const [, secretArg] = vi.mocked(signCookie).mock.calls[0];
      expect(secretArg).toBe(mockEnv.COOKIE_SECRET);
    });
  });
});
