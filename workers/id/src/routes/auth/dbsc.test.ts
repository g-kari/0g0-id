import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...original,
    findActiveBffSession: vi.fn(),
    bindDeviceKeyToBffSession: vi.fn(),
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

import { findActiveBffSession, bindDeviceKeyToBffSession } from "@0g0-id/shared";
import { handleDbscBind } from "./dbsc";

const ADMIN_ORIGIN = "https://admin.0g0.xyz";

function buildApp() {
  const app = new Hono<{ Bindings: ReturnType<typeof createMockIdpEnv> }>();
  app.post("/auth/dbsc/bind", handleDbscBind);
  return {
    request: (init: RequestInit) => {
      const headers = new Headers({
        "Content-Type": "application/json",
        "X-BFF-Origin": ADMIN_ORIGIN,
      });
      // override
      if (init.headers) {
        const incoming = new Headers(init.headers as HeadersInit);
        incoming.forEach((v, k) => headers.set(k, v));
      }
      return app.request(
        new Request("https://id.0g0.xyz/auth/dbsc/bind", {
          method: "POST",
          ...init,
          headers,
        }),
        undefined,
        createMockIdpEnv(),
      );
    },
  };
}

const validJwk = { kty: "EC", crv: "P-256", x: "abcd", y: "efgh" } as const;
const validBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: "sid-1", public_jwk: validJwk, ...extra });

describe("POST /auth/dbsc/bind (IdP internal)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("セッションが見つからなければ 404", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue(null);
    const app = buildApp();
    const res = await app.request({ body: validBody() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_SESSION");
  });

  it("既にバインド済み（UPDATE 0 行）なら 409 ALREADY_BOUND", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue({
      id: "sid-1",
      user_id: "user-1",
      created_at: 1,
      expires_at: 9999999999,
      revoked_at: null,
      revoked_reason: null,
      user_agent: null,
      ip: null,
      bff_origin: ADMIN_ORIGIN,
      device_public_key_jwk: '{"kty":"EC"}',
      device_bound_at: 1234,
    });
    // bindDeviceKeyToBffSession の WHERE で既バインド分は弾かれるため UPDATE は 0 行。
    vi.mocked(bindDeviceKeyToBffSession).mockResolvedValue(false);
    const app = buildApp();
    const res = await app.request({ body: validBody() });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("ALREADY_BOUND");
  });

  it("正常系: bindDeviceKeyToBffSession が呼ばれて 200", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue({
      id: "sid-1",
      user_id: "user-1",
      created_at: 1,
      expires_at: 9999999999,
      revoked_at: null,
      revoked_reason: null,
      user_agent: null,
      ip: null,
      bff_origin: ADMIN_ORIGIN,
      device_public_key_jwk: null,
      device_bound_at: null,
    });
    vi.mocked(bindDeviceKeyToBffSession).mockResolvedValue(true);

    const app = buildApp();
    const res = await app.request({ body: validBody() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { session_id: string; bound_at: number } };
    expect(body.data.session_id).toBe("sid-1");

    expect(bindDeviceKeyToBffSession).toHaveBeenCalledWith(
      expect.anything(),
      "sid-1",
      expect.stringContaining('"kty":"EC"'),
    );
  });

  it("X-BFF-Origin がセッションの bff_origin と一致しない場合 403", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue({
      id: "sid-1",
      user_id: "user-1",
      created_at: 1,
      expires_at: 9999999999,
      revoked_at: null,
      revoked_reason: null,
      user_agent: null,
      ip: null,
      bff_origin: "https://user.0g0.xyz",
      device_public_key_jwk: null,
      device_bound_at: null,
    });
    const app = buildApp();
    const res = await app.request({ body: validBody() });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(bindDeviceKeyToBffSession).not.toHaveBeenCalled();
  });

  it("X-BFF-Origin ヘッダ無しの場合 403", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue({
      id: "sid-1",
      user_id: "user-1",
      created_at: 1,
      expires_at: 9999999999,
      revoked_at: null,
      revoked_reason: null,
      user_agent: null,
      ip: null,
      bff_origin: ADMIN_ORIGIN,
      device_public_key_jwk: null,
      device_bound_at: null,
    });
    const app = buildApp();
    // 上書きで X-BFF-Origin を空にする
    const res = await app.request({ body: validBody(), headers: { "X-BFF-Origin": "" } });
    expect(res.status).toBe(403);
  });

  it("非 EC 鍵は zod バリデーションで弾かれて 400", async () => {
    const app = buildApp();
    const res = await app.request({
      body: JSON.stringify({
        session_id: "sid-1",
        public_jwk: { kty: "RSA", n: "x", e: "AQAB" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("update が 0 行だった場合は 409 ALREADY_BOUND を返す", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue({
      id: "sid-1",
      user_id: "user-1",
      created_at: 1,
      expires_at: 9999999999,
      revoked_at: null,
      revoked_reason: null,
      user_agent: null,
      ip: null,
      bff_origin: ADMIN_ORIGIN,
      device_public_key_jwk: null,
      device_bound_at: null,
    });
    vi.mocked(bindDeviceKeyToBffSession).mockResolvedValue(false);

    const app = buildApp();
    const res = await app.request({ body: validBody() });
    expect(res.status).toBe(409);
  });
});
