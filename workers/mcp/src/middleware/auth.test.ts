import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { findUserById, isAccessTokenRevoked } from "@0g0-id/shared";
import { mcpAuthMiddleware, mcpRejectBannedUserMiddleware, mcpAdminMiddleware } from "./auth";
import { resetJwksCache } from "./auth";

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn().mockReturnValue({}),
  jwtVerify: vi.fn(),
}));

vi.mock("@0g0-id/shared", () => ({
  findUserById: vi.fn(),
  isAccessTokenRevoked: vi.fn(),
  jsonRpcErrorBody: (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: null,
    error: { code, message },
  }),
}));

const mockEnv = {
  DB: {},
  IDP: {},
  IDP_ORIGIN: "https://id.example.com",
  MCP_ORIGIN: "https://mcp.example.com",
};

const baseUrl = "https://mcp.example.com";

const mockPayload = {
  iss: "https://id.example.com",
  sub: "user-123",
  aud: "https://id.example.com",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  jti: "test-jti",
  kid: "test-kid",
  role: "user",
  email: "test@example.com",
};

const mockDbUser = {
  id: "user-123",
  email: "test@example.com",
  banned_at: null,
};

function buildAuthApp() {
  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("*", mcpAuthMiddleware as any);
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

function buildBannedApp(user?: unknown) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (user !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("user" as never, user as any);
    }
    await next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("*", mcpRejectBannedUserMiddleware as any);
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

function buildAdminApp(user?: unknown) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (user !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("user" as never, user as any);
    }
    await next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("*", mcpAdminMiddleware as any);
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: null;
  error: { code: number; message: string };
}

describe("mcpAuthMiddleware", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("Authorizationヘッダーがない場合は401を返す", async () => {
    const app = buildAuthApp();
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32001);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer resource_metadata=");
    expect(res.headers.get("WWW-Authenticate")).toContain(mockEnv.MCP_ORIGIN);
  });

  it("Bearer以外のスキームの場合は401を返す", async () => {
    const app = buildAuthApp();
    const res = await app.request(
      new Request(`${baseUrl}/test`, {
        headers: { Authorization: "Basic abc123" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.error.code).toBe(-32001);
  });

  it("有効なBearerトークンの場合は200を返す", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: mockPayload,
      protectedHeader: { alg: "ES256" },
    } as any);

    const app = buildAuthApp();
    const res = await app.request(
      new Request(`${baseUrl}/test`, {
        headers: { Authorization: "Bearer valid.jwt.token" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(jwtVerify)).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(jwtVerify).mock.calls[0];
    expect(callArgs[0]).toBe("valid.jwt.token");
    expect(callArgs[2]).toEqual(
      expect.objectContaining({
        issuer: mockEnv.IDP_ORIGIN,
        audience: mockEnv.IDP_ORIGIN,
        algorithms: ["ES256"],
      }),
    );
  });

  it("ペイロードがTokenPayloadスキーマに合致しない場合は401を返す", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: "user-123" },
      protectedHeader: { alg: "ES256" },
    } as any);

    const app = buildAuthApp();
    const res = await app.request(
      new Request(`${baseUrl}/test`, {
        headers: { Authorization: "Bearer valid.jwt.token" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe("Invalid token payload");
  });

  it("リボークされたトークンの場合は401を返す", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { ...mockPayload, jti: "revoked-jti" },
      protectedHeader: { alg: "ES256" },
    } as any);
    vi.mocked(isAccessTokenRevoked).mockResolvedValue(true);

    const app = buildAuthApp();
    const res = await app.request(
      new Request(`${baseUrl}/test`, {
        headers: { Authorization: "Bearer valid.jwt.token" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe("Token has been revoked");
    expect(vi.mocked(isAccessTokenRevoked)).toHaveBeenCalledWith(mockEnv.DB, "revoked-jti");
  });

  it("jtiがないトークンの場合はZodバリデーションで401を返す", async () => {
    const payloadWithoutJti = { ...mockPayload, jti: undefined };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: payloadWithoutJti,
      protectedHeader: { alg: "ES256" },
    } as any);

    const app = buildAuthApp();
    const res = await app.request(
      new Request(`${baseUrl}/test`, {
        headers: { Authorization: "Bearer valid.jwt.token" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe("Invalid token payload");
  });

  it("JWT検証失敗時は401を返す", async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error("JWTExpired"));

    const app = buildAuthApp();
    const res = await app.request(
      new Request(`${baseUrl}/test`, {
        headers: { Authorization: "Bearer expired.jwt.token" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe("Invalid or expired token");
    expect(res.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    expect(res.headers.get("WWW-Authenticate")).toContain(mockEnv.MCP_ORIGIN);
  });
});

describe("mcpRejectBannedUserMiddleware", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("ユーザーがコンテキストにない場合は401を返す", async () => {
    const app = buildBannedApp();
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.error.code).toBe(-32001);
  });

  it("ユーザーがDBに存在しない場合は401を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);

    const app = buildBannedApp(mockPayload);
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe("Account suspended or not found");
    expect(vi.mocked(findUserById)).toHaveBeenCalledWith(mockEnv.DB, mockPayload.sub);
  });

  it("BANされたユーザーの場合は401を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...mockDbUser, banned_at: "2024-01-01T00:00:00Z" } as any,
    );

    const app = buildBannedApp(mockPayload);
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe("Account suspended or not found");
  });

  it("正常なユーザーの場合は200を返す", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(findUserById).mockResolvedValue(mockDbUser as any);

    const app = buildBannedApp(mockPayload);
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
  });

  it("DB呼び出しで例外が発生した場合は500を返す", async () => {
    vi.mocked(findUserById).mockRejectedValue(new Error("DB connection failed"));

    const app = buildBannedApp(mockPayload);
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(500);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.error.code).toBe(-32603);
  });
});

describe("mcpAdminMiddleware", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("ユーザーがコンテキストにない場合は403を返す", async () => {
    const app = buildAdminApp();
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(403);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.error.code).toBe(-32001);
  });

  it("adminロール以外のユーザーの場合は403を返す", async () => {
    const app = buildAdminApp({ ...mockPayload, role: "user" });
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(403);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe("Admin role required");
  });

  it("jtiがないadminトークンの場合は401を返す", async () => {
    const app = buildAdminApp({ ...mockPayload, role: "admin", jti: undefined });
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe("Invalid token: missing jti");
  });

  it("リボークされたトークンの場合は401を返す", async () => {
    vi.mocked(isAccessTokenRevoked).mockResolvedValue(true);

    const app = buildAdminApp({ ...mockPayload, role: "admin", jti: "revoked-jti" });
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<JsonRpcErrorResponse>();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe("Token has been revoked");
    expect(vi.mocked(isAccessTokenRevoked)).toHaveBeenCalledWith(mockEnv.DB, "revoked-jti");
  });

  it("adminロールかつ有効なjtiのユーザーの場合は200を返す", async () => {
    vi.mocked(isAccessTokenRevoked).mockResolvedValue(false);

    const app = buildAdminApp({ ...mockPayload, role: "admin", jti: "valid-jti" });
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
  });
});

describe("JWKS cache TTL", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetJwksCache();
  });

  it("TTL内は同じJWKSインスタンスをキャッシュから返す", async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: mockPayload,
      protectedHeader: { alg: "ES256" },
    } as any);

    const app = buildAuthApp();

    await app.request(
      new Request(`${baseUrl}/test`, { headers: { Authorization: "Bearer token1" } }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    await app.request(
      new Request(`${baseUrl}/test`, { headers: { Authorization: "Bearer token2" } }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );

    expect(vi.mocked(createRemoteJWKSet)).toHaveBeenCalledTimes(1);
  });

  it("TTL超過後はJWKSを再生成する", async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: mockPayload,
      protectedHeader: { alg: "ES256" },
    } as any);

    const app = buildAuthApp();

    await app.request(
      new Request(`${baseUrl}/test`, { headers: { Authorization: "Bearer token1" } }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60 * 1000 + 1);

    await app.request(
      new Request(`${baseUrl}/test`, { headers: { Authorization: "Bearer token2" } }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );

    expect(vi.mocked(createRemoteJWKSet)).toHaveBeenCalledTimes(2);
  });
});
