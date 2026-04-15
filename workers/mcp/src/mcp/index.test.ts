import { describe, it, expect } from "vite-plus/test";
import * as mcpModule from "./index";
import { McpServer } from "./server";
import { createMcpRoutes } from "./transport";

describe("mcp/index エクスポート", () => {
  it("McpServer がre-exportされている", () => {
    expect(mcpModule.McpServer).toBe(McpServer);
  });

  it("createMcpRoutes がre-exportされている", () => {
    expect(mcpModule.createMcpRoutes).toBe(createMcpRoutes);
  });

  it("McpServer がクラスとしてインスタンス化できる", () => {
    const server = new mcpModule.McpServer();
    expect(server).toBeInstanceOf(McpServer);
  });
});
