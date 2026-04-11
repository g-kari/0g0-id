import { describe, it, expect, vi } from "vite-plus/test";
import { McpServer } from "./server";
import type { McpContext, McpTool } from "./server";
import type { JsonRpcRequest } from "./types";

const mockContext: McpContext = {
  userId: "user-123",
  userRole: "user",
  db: {} as D1Database,
  idp: {} as Fetcher,
};

function makeRequest(
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 1,
): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

function makeTool(name: string, result?: string, shouldThrow = false): McpTool {
  return {
    definition: {
      name,
      description: `${name} tool`,
      inputSchema: { type: "object", properties: {} },
    },
    handler: vi.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error("tool error");
      return { content: [{ type: "text" as const, text: result ?? `result of ${name}` }] };
    }),
  };
}

describe("McpServer", () => {
  describe("initialize", () => {
    it("プロトコルバージョン・capabilities・serverInfo を返す", async () => {
      const server = new McpServer();
      const res = await server.handleRequest(makeRequest("initialize"), mockContext);
      expect(res.jsonrpc).toBe("2.0");
      expect(res.id).toBe(1);
      expect(res.result).toMatchObject({
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "0g0-id-mcp", version: "0.1.0" },
      });
      expect(res.error).toBeUndefined();
    });
  });

  describe("ping", () => {
    it("空のresultを返す", async () => {
      const server = new McpServer();
      const res = await server.handleRequest(makeRequest("ping"), mockContext);
      expect(res.result).toEqual({});
      expect(res.error).toBeUndefined();
    });
  });

  describe("unknown method", () => {
    it("Method not found エラーを返す", async () => {
      const server = new McpServer();
      const res = await server.handleRequest(makeRequest("unknown/method"), mockContext);
      expect(res.error?.code).toBe(-32601);
      expect(res.error?.message).toContain("unknown/method");
      expect(res.result).toBeUndefined();
    });
  });

  describe("tools/list", () => {
    it("ツール未登録時は空配列を返す", async () => {
      const server = new McpServer();
      const res = await server.handleRequest(makeRequest("tools/list"), mockContext);
      expect(res.result).toEqual({ tools: [] });
    });

    it("登録済みツールの定義一覧を返す", async () => {
      const server = new McpServer();
      server.registerTool(makeTool("listUsers"));
      server.registerTool(makeTool("getUser"));
      const res = await server.handleRequest(makeRequest("tools/list"), mockContext);
      const { tools } = res.result as { tools: unknown[] };
      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({ name: "listUsers" });
      expect(tools[1]).toMatchObject({ name: "getUser" });
    });
  });

  describe("tools/call", () => {
    it("nameパラメータなし → Missing tool name エラー", async () => {
      const server = new McpServer();
      const res = await server.handleRequest(makeRequest("tools/call", {}), mockContext);
      expect(res.error?.code).toBe(-32602);
      expect(res.error?.message).toContain("Missing tool name");
    });

    it("未登録ツール名 → Unknown tool エラー", async () => {
      const server = new McpServer();
      const res = await server.handleRequest(
        makeRequest("tools/call", { name: "nonexistent" }),
        mockContext,
      );
      expect(res.error?.code).toBe(-32602);
      expect(res.error?.message).toContain("nonexistent");
    });

    it("登録済みツールを正常に呼び出せる", async () => {
      const server = new McpServer();
      const tool = makeTool("listUsers", "users list");
      server.registerTool(tool);
      const res = await server.handleRequest(
        makeRequest("tools/call", { name: "listUsers", arguments: { limit: 10 } }),
        mockContext,
      );
      expect(res.error).toBeUndefined();
      expect(res.result).toMatchObject({
        content: [{ type: "text", text: "users list" }],
      });
      expect(tool.handler).toHaveBeenCalledWith({ limit: 10 }, mockContext);
    });

    it("argumentsなしでも呼び出せる（空オブジェクトを渡す）", async () => {
      const server = new McpServer();
      const tool = makeTool("ping");
      server.registerTool(tool);
      await server.handleRequest(makeRequest("tools/call", { name: "ping" }), mockContext);
      expect(tool.handler).toHaveBeenCalledWith({}, mockContext);
    });

    it("ツールハンドラが例外をthrowしたらisError=trueのresultを返す", async () => {
      const server = new McpServer();
      server.registerTool(makeTool("failTool", undefined, true));
      const res = await server.handleRequest(
        makeRequest("tools/call", { name: "failTool" }),
        mockContext,
      );
      expect(res.error).toBeUndefined();
      expect(res.result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Error: tool error" }],
      });
    });

    it("非Errorオブジェクトのthrowも Unknown error としてラップされる", async () => {
      const server = new McpServer();
      const tool: McpTool = {
        definition: { name: "badTool", description: "", inputSchema: {} },
        handler: async () => {
          throw "raw string error";
        },
      };
      server.registerTool(tool);
      const res = await server.handleRequest(
        makeRequest("tools/call", { name: "badTool" }),
        mockContext,
      );
      expect(res.result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Error: Unknown error" }],
      });
    });
  });

  describe("id の受け渡し", () => {
    it("リクエストのidがレスポンスにそのまま反映される", async () => {
      const server = new McpServer();
      const res = await server.handleRequest(
        makeRequest("ping", undefined, "req-abc"),
        mockContext,
      );
      expect(res.id).toBe("req-abc");
    });
  });
});
