import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";

vi.mock("@0g0-id/shared", () => ({
  verifyAccessToken: vi.fn(),
  isAccessTokenRevoked: vi.fn().mockResolvedValue(false),
  findUserById: vi.fn(),
  createLogger: vi
    .fn()
    .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { verifyAccessToken, findUserById } from "@0g0-id/shared";
import type { TokenPayload, User } from "@0g0-id/shared";
import { authMiddleware, rejectBannedUserMiddleware, rejectServiceTokenMiddleware } from "./auth";

const baseUrl = "https://id.0g0.xyz";

const mockEnv = {
  DB: {} as D1Database,
  IDP_ORIGIN: "https://id.0g0.xyz",
  USER_ORIGIN: "https://user.0g0.xyz",
  ADMIN_ORIGIN: "https://admin.0g0.xyz",
  JWT_PRIVATE_KEY: "mock-private-key",
  JWT_PUBLIC_KEY: "mock-public-key",
};

const mockPayload = {
  sub: "user-1",
  email: "test@example.com",
  role: "user" as const,
  iss: "https://id.0g0.xyz",
  aud: "https://id.0g0.xyz",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 900,
  jti: "jti-1",
  kid: "kid-1",
};

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv; Variables: { user: TokenPayload } }>();
  app.use("/protected/*", authMiddleware);
  app.get("/protected/resource", (c) => {
    const user = c.get("user");
    return c.json({ ok: true, userId: user.sub });
  });
  return app;
}

describe("authMiddleware", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("Authorizationヘッダーなし → 401を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("Bearer以外のスキーム → 401を返す", async () => {
    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`, {
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("無効なトークン → 401を返す", async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error("invalid token"));

    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`, {
        headers: { Authorization: "Bearer invalid-token" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("有効なトークン → 200を返してuserをコンテキストに設定する", async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(mockPayload as never);

    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`, {
        headers: { Authorization: "Bearer valid-token" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; userId: string }>();
    expect(body.ok).toBe(true);
    expect(body.userId).toBe("user-1");

    expect(vi.mocked(verifyAccessToken)).toHaveBeenCalledWith(
      "valid-token",
      mockEnv.JWT_PUBLIC_KEY,
      mockEnv.IDP_ORIGIN,
      mockEnv.IDP_ORIGIN,
    );
  });

  it("期限切れトークン（検証失敗）→ 401を返す", async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error("token expired"));

    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`, {
        headers: { Authorization: "Bearer expired-token" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
  });
});

describe("rejectServiceTokenMiddleware", () => {
  function buildApp(mockUser?: Partial<TokenPayload>) {
    const app = new Hono<{ Bindings: typeof mockEnv; Variables: { user: TokenPayload } }>();
    if (mockUser !== undefined) {
      app.use("/protected/*", (c, next) => {
        c.set("user", mockUser as TokenPayload);
        return next();
      });
    }
    app.use("/protected/*", rejectServiceTokenMiddleware);
    app.get("/protected/resource", (c) => c.json({ ok: true }));
    return app;
  }

  it("userがコンテキストに未設定 → 401を返す", async () => {
    const app = buildApp(undefined);
    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("cidあり（サービストークン）→ 403を返す", async () => {
    const app = buildApp({ ...mockPayload, cid: "service-client-id" });
    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("cidなし（BFFセッショントークン）→ nextを呼び出して200を返す", async () => {
    const app = buildApp({ ...mockPayload, cid: undefined });
    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });
});

describe("rejectBannedUserMiddleware", () => {
  const mockDbUser: User = {
    id: "user-1",
    google_sub: null,
    line_sub: null,
    twitch_sub: null,
    github_sub: null,
    x_sub: null,
    email: "test@example.com",
    email_verified: 1,
    name: "Test User",
    picture: null,
    phone: null,
    address: null,
    role: "user",
    banned_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };

  function buildApp(mockUser?: Partial<TokenPayload>) {
    const app = new Hono<{
      Bindings: typeof mockEnv;
      Variables: { user: TokenPayload; dbUser: User };
    }>();
    if (mockUser !== undefined) {
      app.use("/protected/*", (c, next) => {
        c.set("user", mockUser as TokenPayload);
        return next();
      });
    }
    app.use("/protected/*", rejectBannedUserMiddleware);
    app.get("/protected/resource", (c) => {
      const dbUser = c.get("dbUser");
      return c.json({ ok: true, userId: dbUser.id });
    });
    return app;
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("userがコンテキストに未設定 → 401を返す", async () => {
    const app = buildApp(undefined);
    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("findUserByIdがDB例外をスロー → 500を返す", async () => {
    vi.mocked(findUserById).mockRejectedValue(new Error("DB error"));
    const app = buildApp(mockPayload);
    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("ユーザーがDBに存在しない → 401を返す（ユーザー列挙防止）", async () => {
    vi.mocked(findUserById).mockResolvedValue(null);
    const app = buildApp(mockPayload);
    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBe("Account suspended or not found");
  });

  it("BAN済みユーザー（banned_at設定済み）→ 401を返す", async () => {
    vi.mocked(findUserById).mockResolvedValue({
      ...mockDbUser,
      banned_at: "2024-06-01T00:00:00Z",
    });
    const app = buildApp(mockPayload);
    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBe("Account suspended or not found");
  });

  it("正常ユーザー → dbUserをコンテキストに設定してnextを呼び出す", async () => {
    vi.mocked(findUserById).mockResolvedValue(mockDbUser);
    const app = buildApp(mockPayload);
    const res = await app.request(
      new Request(`${baseUrl}/protected/resource`),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; userId: string }>();
    expect(body.ok).toBe(true);
    expect(body.userId).toBe("user-1");
  });
});
