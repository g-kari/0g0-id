import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { Hono } from "hono";
import { routePath } from "hono/route";
import { logger } from "./logger";

vi.mock("hono/route", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hono/route")>();
  return { ...actual, routePath: vi.fn(actual.routePath) };
});

const CANARY = "synthetic-private-user-731@example.invalid";

function buildApp(handler?: (c: import("hono").Context) => Response | Promise<Response>) {
  const app = new Hono();
  app.use("*", logger());
  app.get("/test", handler ?? ((c) => c.json({ ok: true })));
  return app;
}

interface LogEntry {
  level: string;
  ctx: string;
  msg: string;
  data: Record<string, unknown>;
}

describe("logger middleware", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
    vi.mocked(routePath).mockReset();
  });

  function entry(): LogEntry {
    expect(consoleSpy).toHaveBeenCalledOnce();
    const line = consoleSpy.mock.calls[0][0] as string;
    expect(line).not.toContain(CANARY);
    expect(line).not.toContain(encodeURIComponent(CANARY));
    return JSON.parse(line) as LogEntry;
  }

  it("登録routeとmethod/status/elapsedだけを1回記録する", async () => {
    const res = await buildApp().request("https://id.0g0.xyz/test");
    expect(res.status).toBe(200);
    const output = entry();
    expect(output).toEqual({
      level: "info",
      ctx: "http",
      msg: "request",
      data: { method: "GET", path: "/test", status: 200, elapsed_ms: expect.any(Number) },
    });
  });

  it.each([
    "code",
    "state",
    "token",
    "access_token",
    "refresh_token",
    "code_verifier",
    "client_secret",
    "email",
    "name",
    "login_hint",
    "link_token",
    "unknown",
    "CODE",
    "%63ode",
    "e%6dail",
  ])("query key %s の値を含め全queryを記録しない", async (key) => {
    await buildApp().request(`https://id.0g0.xyz/test?${key}=${encodeURIComponent(CANARY)}`);
    expect(entry().data.path).toBe("/test");
  });

  it("重複query/encoded redirect/fragmentを記録せずhandlerへそのまま渡す", async () => {
    const nested = `https://client.example.invalid/users/${CANARY}?token=${CANARY}`;
    const app = buildApp((c) =>
      c.json({ values: c.req.queries("email"), redirect: c.req.query("redirect_uri") }),
    );
    const res = await app.request(
      `https://id.0g0.xyz/test?email=${encodeURIComponent(CANARY)}&email=second&redirect_uri=${encodeURIComponent(nested)}#${CANARY}`,
    );
    expect(await res.json()).toEqual({ values: [CANARY, "second"], redirect: nested });
    expect(entry().data.path).toBe("/test");
  });

  it("Authorization/Cookie/bodyを記録・消費せずPOST応答を保つ", async () => {
    const app = new Hono();
    app.use("*", logger());
    app.post("/test", async (c) =>
      c.json(
        {
          body: await c.req.text(),
          auth: c.req.header("Authorization"),
          cookie: c.req.header("Cookie"),
        },
        201,
      ),
    );
    const res = await app.request("https://id.0g0.xyz/test", {
      method: "POST",
      headers: { Authorization: `Bearer ${CANARY}`, Cookie: `session=${CANARY}` },
      body: CANARY,
    });
    expect(await res.json()).toEqual({
      body: CANARY,
      auth: `Bearer ${CANARY}`,
      cookie: `session=${CANARY}`,
    });
    expect(entry().data).toMatchObject({ method: "POST", path: "/test", status: 201 });
  });

  it.each([CANARY, "731bdc41-0987-4567-8912-abcdef123456", "a".repeat(64)])(
    "動的path値 %s はroute parameterへ置換する",
    async (value) => {
      const app = new Hono();
      app.use("*", logger());
      app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));
      const res = await app.request(`https://id.0g0.xyz/users/${encodeURIComponent(value)}`);
      expect(await res.json()).toEqual({ id: value });
      const output = entry();
      expect(output.data.path).toBe("/users/:id");
      expect(JSON.stringify(output)).not.toContain(value);
    },
  );

  it("ネストrouteの動的prefixとparamを記録しない", async () => {
    const app = new Hono();
    const nested = new Hono();
    app.use("*", logger());
    nested.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));
    app.route("/api/:tenant", nested);
    const res = await app.request(
      `https://id.0g0.xyz/api/${encodeURIComponent(CANARY)}/users/${encodeURIComponent(CANARY)}?email=${encodeURIComponent(CANARY)}`,
    );
    expect(await res.json()).toEqual({ id: CANARY });
    expect(entry().data.path).toBe("/api/:tenant/users/:id");
  });

  it.each([401, 403] as const)("早期拒否%dのstatusとmiddleware patternを保つ", async (status) => {
    const app = new Hono();
    app.use("*", logger());
    app.use("/api/*", async (c) => c.json({ denied: true }, status));
    app.get("/api/users/:id", (c) => c.text("not reached"));
    const res = await app.request(
      `https://id.0g0.xyz/api/users/${encodeURIComponent(CANARY)}?link_token=${CANARY}`,
    );
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ denied: true });
    expect(entry().data).toMatchObject({ path: "/api/*", status });
  });

  it("未登録404を固定分類しrequest pathへfallbackしない", async () => {
    const res = await buildApp().request(
      `https://id.0g0.xyz/${encodeURIComponent(CANARY)}?email=${CANARY}`,
    );
    expect(res.status).toBe(404);
    expect(entry().data).toMatchObject({ path: "[unmatched]", status: 404 });
  });

  it("登録routeが返す404も固定分類する", async () => {
    const app = new Hono();
    app.use("*", logger());
    app.get("/users/:id", (c) => c.json({ missing: true }, 404));
    const res = await app.request(`https://id.0g0.xyz/users/${encodeURIComponent(CANARY)}`);
    expect(res.status).toBe(404);
    expect(entry().data.path).toBe("[unmatched]");
  });

  it("SPA catchallも固定分類する", async () => {
    const app = new Hono();
    app.use("*", logger());
    app.get("*", (c) => c.text("synthetic app"));
    const res = await app.request(`https://user.0g0.xyz/profile/${encodeURIComponent(CANARY)}`);
    expect(await res.text()).toBe("synthetic app");
    expect(entry().data).toMatchObject({ path: "[unmatched]", status: 200 });
  });

  it.each([500, 503] as const)(
    "処理済み例外%dを固定分類し例外本文をHTTP logへ出さない",
    async (status) => {
      const app = new Hono();
      app.use("*", logger());
      app.onError((_err, c) => c.json({ error: "synthetic failure" }, status));
      app.get("/fail/:id", () => {
        throw new Error(CANARY);
      });
      const res = await app.request(`https://id.0g0.xyz/fail/${encodeURIComponent(CANARY)}`);
      expect(await res.json()).toEqual({ error: "synthetic failure" });
      expect(entry().data).toMatchObject({ path: "[error]", status });
    },
  );

  it.each([
    "",
    undefined,
    `https://example.invalid/${CANARY}`,
    `/registered/${CANARY}`,
    `/registered/${encodeURIComponent(CANARY)}`,
    `/test?email=${CANARY}`,
    "/" + "x".repeat(257),
    "/bad path",
  ])("無効route metadataから生URLへfallbackしない", async (pattern) => {
    vi.mocked(routePath).mockReturnValueOnce(pattern as string);
    await buildApp().request(`https://id.0g0.xyz/test?email=${CANARY}`);
    expect(entry().data.path).toBe("[unmatched]");
  });

  it("route metadata取得失敗は成功responseを壊さず固定分類する", async () => {
    vi.mocked(routePath).mockImplementationOnce(() => {
      throw new Error(CANARY);
    });
    const res = await buildApp().request(`https://id.0g0.xyz/test?token=${CANARY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(entry().data.path).toBe("[unmatched]");
  });

  it("長いqueryも記録せずresponseと経過時間を保つ", async () => {
    const res = await buildApp().request(
      `https://id.0g0.xyz/test?unknown=${CANARY}${"x".repeat(16384)}`,
    );
    expect(res.status).toBe(200);
    const output = entry();
    expect(output.data.path).toBe("/test");
    expect(output.data.elapsed_ms as number).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(output).length).toBeLessThan(200);
  });

  it("独自HTTP methodの生値を記録せずrequestは変更しない", async () => {
    const method = "SYNTHETIC_PRIVATE_CANARY731";
    const app = new Hono();
    app.use("*", logger());
    app.all("/test", (c) => c.text(c.req.method));
    const res = await app.request("https://id.0g0.xyz/test", { method });
    expect(await res.text()).toBe(method);
    const output = entry();
    expect(output.data.method).toBe("[other]");
    expect(JSON.stringify(output)).not.toContain(method);
  });

  it.each(["HEAD", "OPTIONS"])("標準method %s と成功statusを保持する", async (method) => {
    const app = new Hono();
    app.use("*", logger());
    app.all("/test", (c) => c.text("synthetic response"));
    const res = await app.request("https://id.0g0.xyz/test", { method });
    expect(res.status).toBe(200);
    expect(entry().data).toMatchObject({ method, path: "/test", status: 200 });
  });

  it.each([413, 429] as const)("全体middlewareの早期拒否%dを固定分類する", async (status) => {
    const app = new Hono();
    app.use("*", logger());
    app.use("*", async (c) => c.json({ denied: true }, status));
    app.get("/test", (c) => c.text("not reached"));
    const res = await app.request(`https://id.0g0.xyz/test?email=${CANARY}`);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ denied: true });
    expect(entry().data).toMatchObject({ path: "[unmatched]", status });
  });
});
