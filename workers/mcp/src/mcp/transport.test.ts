import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { createMcpRoutes } from "./transport";
import { McpServer } from "./server";
import type { McpContext } from "./server";
import { createMcpSession, validateAndRefreshMcpSession, deleteMcpSession } from "@0g0-id/shared";

vi.mock("@0g0-id/shared", () => ({
  createMcpSession: vi.fn(),
  validateAndRefreshMcpSession: vi.fn(),
  deleteMcpSession: vi.fn(),
}));

const mockContext: McpContext = {
  userId: "user-123",
  userRole: "user",
  db: {} as D1Database,
  idp: {} as Fetcher,
};

const mockEnv = {
  DB: {} as D1Database,
};

const baseUrl = "https://mcp.0g0.xyz";

function buildApp(server?: McpServer) {
  const mcpServer = server ?? new McpServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes = createMcpRoutes(mcpServer) as any;

  const app = new Hono();
  app.use("*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).set("mcpContext", mockContext);
    await next();
  });
  app.route("/mcp", routes);
  return app;
}

function makePostRequest(body: unknown, headers?: Record<string, string>) {
  return new Request(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("createMcpRoutes - POST /mcp", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("不正なJSONを送信した場合はParseError(-32700)を返す", async () => {
    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid json!!!",
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{
      jsonrpc: string;
      id: null;
      error: { code: number; message: string };
    }>();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32700);
    expect(body.error.message).toBe("Parse error");
  });

  it("initializeリクエストで新セッションを作成しMcp-Session-Idヘッダーを返す", async () => {
    vi.mocked(createMcpSession).mockResolvedValue(undefined as never);

    const app = buildApp();
    const res = await app.request(
      makePostRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    const sessionId = res.headers.get("Mcp-Session-Id");
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe("string");
    expect(vi.mocked(createMcpSession)).toHaveBeenCalledWith(
      mockEnv.DB,
      expect.any(String),
      mockContext.userId,
    );
    const body = await res.json<{ result: { protocolVersion: string } }>();
    expect(body.result.protocolVersion).toBeDefined();
  });

  it("initialize以外でセッションIDがない場合は-32600エラーを返す", async () => {
    const app = buildApp();
    const res = await app.request(
      makePostRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ error: { code: number; message: string } }>();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain("session");
    expect(vi.mocked(validateAndRefreshMcpSession)).not.toHaveBeenCalled();
  });

  it("initialize以外で無効なセッションIDの場合は-32600エラーを返す", async () => {
    vi.mocked(validateAndRefreshMcpSession).mockResolvedValue(false);

    const app = buildApp();
    const res = await app.request(
      makePostRequest(
        { jsonrpc: "2.0", id: 3, method: "tools/list" },
        {
          "Mcp-Session-Id": "invalid-session-id",
        },
      ),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ error: { code: number; message: string } }>();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain("session");
    expect(vi.mocked(validateAndRefreshMcpSession)).toHaveBeenCalledWith(
      mockEnv.DB,
      "invalid-session-id",
    );
  });

  it("有効なセッションIDで通常のリクエストを処理できる", async () => {
    vi.mocked(validateAndRefreshMcpSession).mockResolvedValue(true);

    const app = buildApp();
    const res = await app.request(
      makePostRequest(
        { jsonrpc: "2.0", id: 4, method: "tools/list" },
        {
          "Mcp-Session-Id": "valid-session-id",
        },
      ),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ result: { tools: unknown[] } }>();
    expect(body.result.tools).toEqual([]);
    expect(vi.mocked(validateAndRefreshMcpSession)).toHaveBeenCalledWith(
      mockEnv.DB,
      "valid-session-id",
    );
  });

  it("Notification（idなし）は処理をスキップしてレスポンスに含めない", async () => {
    const app = buildApp();
    const res = await app.request(
      makePostRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe("");
  });

  it("全てNotificationのバッチは202を返す", async () => {
    const app = buildApp();
    const res = await app.request(
      makePostRequest([
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", method: "notifications/progress" },
      ]),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(202);
  });

  it("バッチリクエストで複数のレスポンスを配列で返す", async () => {
    vi.mocked(validateAndRefreshMcpSession).mockResolvedValue(true);

    const app = buildApp();
    const res = await app.request(
      makePostRequest(
        [
          { jsonrpc: "2.0", id: 5, method: "ping" },
          { jsonrpc: "2.0", id: 6, method: "tools/list" },
        ],
        {
          "Mcp-Session-Id": "valid-session-id",
        },
      ),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    const body = await res.json<unknown[]>();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });

  it("バッチにNotificationが混在する場合はidのあるリクエストのみレスポンスを返す", async () => {
    vi.mocked(validateAndRefreshMcpSession).mockResolvedValue(true);

    const app = buildApp();
    const res = await app.request(
      makePostRequest(
        [
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 7, method: "ping" },
        ],
        {
          "Mcp-Session-Id": "valid-session-id",
        },
      ),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    // 1件のみなのでオブジェクト形式
    const body = await res.json<{ id: number; result: unknown }>();
    expect(body.id).toBe(7);
  });

  it("idがレスポンスにそのまま反映される", async () => {
    vi.mocked(validateAndRefreshMcpSession).mockResolvedValue(true);

    const app = buildApp();
    const res = await app.request(
      makePostRequest(
        { jsonrpc: "2.0", id: "req-abc-123", method: "ping" },
        {
          "Mcp-Session-Id": "valid-session-id",
        },
      ),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    const body = await res.json<{ id: string }>();
    expect(body.id).toBe("req-abc-123");
  });
});

describe("createMcpRoutes - GET /mcp", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("セッションIDがない場合は400を返す", async () => {
    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/mcp`, { method: "GET" }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBeDefined();
    expect(vi.mocked(validateAndRefreshMcpSession)).not.toHaveBeenCalled();
  });

  it("無効なセッションIDの場合は400を返す", async () => {
    vi.mocked(validateAndRefreshMcpSession).mockResolvedValue(false);

    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/mcp`, {
        method: "GET",
        headers: { "Mcp-Session-Id": "invalid-id" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBeDefined();
  });

  it("有効なセッションIDの場合はSSEストリームを返す", async () => {
    vi.mocked(validateAndRefreshMcpSession).mockResolvedValue(true);

    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/mcp`, {
        method: "GET",
        headers: { "Mcp-Session-Id": "valid-session-id" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    // SSEストリームは閉じないため、ヘッダーのみ確認してボディ読み取りはスキップ
    void res.body?.cancel();
  });
});

describe("createMcpRoutes - DELETE /mcp", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("セッションIDがある場合はセッションを削除して204を返す", async () => {
    vi.mocked(deleteMcpSession).mockResolvedValue(undefined as never);

    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": "session-to-delete" },
      }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(204);
    expect(vi.mocked(deleteMcpSession)).toHaveBeenCalledWith(mockEnv.DB, "session-to-delete");
  });

  it("セッションIDがない場合もdeleteMcpSessionを呼ばずに204を返す", async () => {
    const app = buildApp();
    const res = await app.request(
      new Request(`${baseUrl}/mcp`, { method: "DELETE" }),
      undefined,
      mockEnv as unknown as Record<string, string>,
    );
    expect(res.status).toBe(204);
    expect(vi.mocked(deleteMcpSession)).not.toHaveBeenCalled();
  });
});
