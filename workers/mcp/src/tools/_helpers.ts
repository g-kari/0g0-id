import type { McpToolResult } from "../mcp/server";

export function requireString(value: unknown, paramName: string): string | McpToolResult {
  if (typeof value !== "string" || value.length === 0) {
    return errorResponse(`${paramName} は必須です`);
  }
  return value;
}

export function errorResponse(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function jsonResponse(data: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function textResponse(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }] };
}

export function isErrorResponse(result: string | McpToolResult): result is McpToolResult {
  return typeof result !== "string";
}
