import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...original,
    findActiveBffSession: vi.fn(),
    bindDeviceKeyToBffSession: vi.fn(),
    issueDbscChallenge: vi.fn(),
    consumeDbscChallenge: vi.fn(),
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

import {
  findActiveBffSession,
  bindDeviceKeyToBffSession,
  issueDbscChallenge,
  consumeDbscChallenge,
} from "@0g0-id/shared";
import { handleDbscBind, handleDbscChallenge, handleDbscVerify, handleDbscStatus } from "./dbsc";

const ADMIN_ORIGIN = "https://admin.0g0.xyz";

function buildApp(path: "bind" | "challenge" | "verify" | "status" = "bind") {
  const app = new Hono<{ Bindings: ReturnType<typeof createMockIdpEnv> }>();
  app.post("/auth/dbsc/bind", handleDbscBind);
  app.post("/auth/dbsc/challenge", handleDbscChallenge);
  app.post("/auth/dbsc/verify", handleDbscVerify);
  app.post("/auth/dbsc/status", handleDbscStatus);
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
        new Request(`https://id.0g0.xyz/auth/dbsc/${path}`, {
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

function activeBoundSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sid-1",
    user_id: "user-1",
    created_at: 1,
    expires_at: 9999999999,
    revoked_at: null,
    revoked_reason: null,
    user_agent: null,
    ip: null,
    bff_origin: ADMIN_ORIGIN,
    device_public_key_jwk: '{"kty":"EC","crv":"P-256","x":"a","y":"b"}',
    device_bound_at: 1234,
    ...overrides,
  } as never;
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

describe("POST /auth/dbsc/challenge (IdP internal)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("端末バインド済みセッションに対し nonce を発行する", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue(activeBoundSession());
    vi.mocked(issueDbscChallenge).mockResolvedValue({
      nonce: "n-xyz",
      session_id: "sid-1",
      expires_at: 9999,
    });
    const app = buildApp("challenge");
    const res = await app.request({ body: JSON.stringify({ session_id: "sid-1" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { nonce: string; expires_at: number } };
    expect(typeof body.data.nonce).toBe("string");
    expect(body.data.nonce.length).toBeGreaterThan(0);
  });

  it("端末未バインドは 404 INVALID_SESSION", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue(
      activeBoundSession({ device_public_key_jwk: null, device_bound_at: null }),
    );
    const app = buildApp("challenge");
    const res = await app.request({ body: JSON.stringify({ session_id: "sid-1" }) });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_SESSION");
  });

  it("存在しないセッションは 404 INVALID_SESSION", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue(null);
    const app = buildApp("challenge");
    const res = await app.request({ body: JSON.stringify({ session_id: "sid-1" }) });
    expect(res.status).toBe(404);
  });

  it("X-BFF-Origin 不一致は 403", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue(
      activeBoundSession({ bff_origin: "https://user.0g0.xyz" }),
    );
    const app = buildApp("challenge");
    const res = await app.request({ body: JSON.stringify({ session_id: "sid-1" }) });
    expect(res.status).toBe(403);
    expect(issueDbscChallenge).not.toHaveBeenCalled();
  });
});

describe("POST /auth/dbsc/verify (IdP internal)", () => {
  beforeEach(() => vi.resetAllMocks());

  async function setupBoundSession() {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    vi.mocked(findActiveBffSession).mockResolvedValue(
      activeBoundSession({ device_public_key_jwk: JSON.stringify(publicJwk) }),
    );
    return { privateKey };
  }

  async function signProof(privateKey: CryptoKey, audience: string, jti: string): Promise<string> {
    return await new SignJWT({ aud: audience })
      .setProtectedHeader({ alg: "ES256", typ: "jwt" })
      .setIssuedAt()
      .setJti(jti)
      .sign(privateKey);
  }

  it("正規 proof と未消費 nonce の場合 200", async () => {
    const { privateKey } = await setupBoundSession();
    vi.mocked(consumeDbscChallenge).mockResolvedValue({ ok: true, session_id: "sid-1" });
    const jwt = await signProof(privateKey, ADMIN_ORIGIN, "n-123");
    const app = buildApp("verify");
    const res = await app.request({
      body: JSON.stringify({ session_id: "sid-1", jwt }),
    });
    expect(res.status).toBe(200);
    expect(consumeDbscChallenge).toHaveBeenCalledWith(expect.anything(), {
      nonce: "n-123",
      sessionId: "sid-1",
    });
  });

  it("nonce が未消費でない（リプレイ）場合 400 INVALID_PROOF", async () => {
    const { privateKey } = await setupBoundSession();
    vi.mocked(consumeDbscChallenge).mockResolvedValue({ ok: false });
    const jwt = await signProof(privateKey, ADMIN_ORIGIN, "n-replay");
    const app = buildApp("verify");
    const res = await app.request({
      body: JSON.stringify({ session_id: "sid-1", jwt }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_PROOF");
  });

  it("端末未バインドセッションは 400 INVALID_PROOF", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue(
      activeBoundSession({ device_public_key_jwk: null, device_bound_at: null }),
    );
    const app = buildApp("verify");
    const res = await app.request({
      body: JSON.stringify({ session_id: "sid-1", jwt: "a.b.c" }),
    });
    expect(res.status).toBe(400);
    expect(consumeDbscChallenge).not.toHaveBeenCalled();
  });

  it("別鍵で署名された proof は 400 INVALID_PROOF（nonce は消費しない）", async () => {
    await setupBoundSession();
    const { privateKey: otherKey } = await generateKeyPair("ES256", { extractable: true });
    const jwt = await signProof(otherKey, ADMIN_ORIGIN, "n-1");
    const app = buildApp("verify");
    const res = await app.request({
      body: JSON.stringify({ session_id: "sid-1", jwt }),
    });
    expect(res.status).toBe(400);
    expect(consumeDbscChallenge).not.toHaveBeenCalled();
  });

  it("audience は IdP が session.bff_origin を強制する — 他オリジン向け proof は 400 INVALID_PROOF", async () => {
    const { privateKey } = await setupBoundSession();
    // proof の aud に他オリジンを指定しても IdP が session.bff_origin で検証するため拒否される
    const jwt = await signProof(privateKey, "https://other.example", "n-1");
    const app = buildApp("verify");
    const res = await app.request({
      body: JSON.stringify({ session_id: "sid-1", jwt }),
    });
    expect(res.status).toBe(400);
    expect(consumeDbscChallenge).not.toHaveBeenCalled();
  });

  it("X-BFF-Origin 不一致は 403（nonce は消費しない）", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue(
      activeBoundSession({ bff_origin: "https://user.0g0.xyz" }),
    );
    const app = buildApp("verify");
    const res = await app.request({
      body: JSON.stringify({ session_id: "sid-1", jwt: "a.b.c" }),
    });
    expect(res.status).toBe(403);
    expect(consumeDbscChallenge).not.toHaveBeenCalled();
  });
});

describe("POST /auth/dbsc/status (IdP internal)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("端末バインド済みセッションは device_bound=true を返す", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue(activeBoundSession());
    const app = buildApp("status");
    const res = await app.request({ body: JSON.stringify({ session_id: "sid-1" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { device_bound: boolean; device_bound_at: number | null };
    };
    expect(body.data.device_bound).toBe(true);
    expect(body.data.device_bound_at).toBe(1234);
  });

  it("端末未バインドセッションは device_bound=false を返す", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue(
      activeBoundSession({ device_public_key_jwk: null, device_bound_at: null }),
    );
    const app = buildApp("status");
    const res = await app.request({ body: JSON.stringify({ session_id: "sid-1" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { device_bound: boolean; device_bound_at: number | null };
    };
    expect(body.data.device_bound).toBe(false);
    expect(body.data.device_bound_at).toBeNull();
  });

  it("存在しない/失効セッションは 200 + device_bound=false（列挙攻撃対策）", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue(null);
    const app = buildApp("status");
    const res = await app.request({ body: JSON.stringify({ session_id: "sid-missing" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { device_bound: boolean; device_bound_at: number | null };
    };
    expect(body.data.device_bound).toBe(false);
    expect(body.data.device_bound_at).toBeNull();
  });

  it("X-BFF-Origin 不一致は 200 + device_bound=false（列挙攻撃対策で存在しないセッションと区別しない）", async () => {
    vi.mocked(findActiveBffSession).mockResolvedValue(
      activeBoundSession({ bff_origin: "https://user.0g0.xyz" }),
    );
    const app = buildApp("status");
    const res = await app.request({ body: JSON.stringify({ session_id: "sid-1" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { device_bound: boolean; device_bound_at: number | null };
    };
    expect(body.data.device_bound).toBe(false);
    expect(body.data.device_bound_at).toBeNull();
  });

  it("session_id 欠落は 400", async () => {
    const app = buildApp("status");
    const res = await app.request({ body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });
});
