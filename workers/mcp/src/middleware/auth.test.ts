import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { jwtVerify } from "jose";
import { findUserById, isAccessTokenRevoked } from "@0g0-id/shared";
import { mcpAuthMiddleware, mcpRejectBannedUserMiddleware, mcpAdminMiddleware } from "./auth";

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn().mockReturnValue({}),
  jwtVerify: vi.fn(),
}));

vi.mock("@0g0-id/shared", () => ({
  findUserById: vi.fn(),
  isAccessTokenRevoked: vi.fn(),
}));

const mockEnv = {
  DB: {},
  IDP: {},
  IDP_ORIGIN: "https://id.example.com",
  MCP_ORIGIN: "https://mcp.example.com",
};

const baseUrl = "https://mcp.example.com";

const mockPayload = {
  sub: "user-123",
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
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
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
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
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
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBe("Token has been revoked");
    expect(vi.mocked(isAccessTokenRevoked)).toHaveBeenCalledWith(mockEnv.DB, "revoked-jti");
  });

  it("jtiがないトークンの場合はリボークチェックをスキップして200を返す", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: mockPayload, // jtiなし
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
    expect(vi.mocked(isAccessTokenRevoked)).not.toHaveBeenCalled();
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
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
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
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
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
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
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
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
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
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
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
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("adminロール以外のユーザーの場合は403を返す", async () => {
    const app = buildAdminApp({ ...mockPayload, role: "user" });
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Admin role required");
  });

  it("jtiがないadminトークンの場合は401を返す", async () => {
    const app = buildAdminApp({ ...mockPayload, role: "admin" });
    const res = await app.request(
      new Request(`${baseUrl}/test`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
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
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
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
