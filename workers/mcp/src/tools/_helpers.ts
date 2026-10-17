import type { McpToolResult } from "../mcp/server";
import { findServiceById, findUserById } from "@0g0-id/shared";

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

export type ValidatedService = {
  serviceId: string;
  service: Awaited<ReturnType<typeof findServiceById>> & {};
};
export type ValidatedUser = { userId: string; user: Awaited<ReturnType<typeof findUserById>> & {} };

export async function requireServiceValidation(
  params: Record<string, unknown>,
  db: D1Database,
): Promise<ValidatedService | McpToolResult> {
  const serviceId = requireString(params.service_id, "service_id");
  if (isErrorResponse(serviceId)) return serviceId;
  const service = await findServiceById(db, serviceId);
  if (!service) return errorResponse("サービスが見つかりません");
  return { serviceId, service };
}

export async function requireUserValidation(
  params: Record<string, unknown>,
  db: D1Database,
): Promise<ValidatedUser | McpToolResult> {
  const userId = requireString(params.user_id, "user_id");
  if (isErrorResponse(userId)) return userId;
  const user = await findUserById(db, userId);
  if (!user) return errorResponse("ユーザーが見つかりません");
  return { userId, user };
}

export function isValidationError<T>(result: T | McpToolResult): result is McpToolResult {
  return "content" in (result as McpToolResult);
}
