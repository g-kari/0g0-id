import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDefinition,
  McpServerInfo,
  McpCapabilities,
} from './types';

export interface McpTool {
  definition: McpToolDefinition;
  handler: (params: Record<string, unknown>, context: McpContext) => Promise<McpToolResult>;
}

export interface McpContext {
  userId: string;
  userRole: string;
  db: D1Database;
  idp: Fetcher;
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export class McpServer {
  private tools: Map<string, McpTool> = new Map();
  private serverInfo: McpServerInfo = { name: '0g0-id-mcp', version: '0.1.0' };
  private capabilities: McpCapabilities = { tools: {} };

  registerTool(tool: McpTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  async handleRequest(request: JsonRpcRequest, context: McpContext): Promise<JsonRpcResponse> {
    switch (request.method) {
      case 'initialize':
        return this.handleInitialize(request);
      case 'tools/list':
        return this.handleToolsList(request);
      case 'tools/call':
        return this.handleToolsCall(request, context);
      case 'ping':
        return { jsonrpc: '2.0', id: request.id, result: {} };
      default:
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
    }
  }

  private handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: this.capabilities,
        serverInfo: this.serverInfo,
      },
    };
  }

  private handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
    const tools = Array.from(this.tools.values()).map((t) => t.definition);
    return { jsonrpc: '2.0', id: request.id, result: { tools } };
  }

  private async handleToolsCall(
    request: JsonRpcRequest,
    context: McpContext,
  ): Promise<JsonRpcResponse> {
    const params = request.params as
      | { name: string; arguments?: Record<string, unknown> }
      | undefined;
    if (!params?.name) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: 'Missing tool name' },
      };
    }
    const tool = this.tools.get(params.name);
    if (!tool) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: `Unknown tool: ${params.name}` },
      };
    }
    try {
      const result = await tool.handler(params.arguments ?? {}, context);
      return { jsonrpc: '2.0', id: request.id, result };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [
            { type: 'text', text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` },
          ],
          isError: true,
        },
      };
    }
  }
}
