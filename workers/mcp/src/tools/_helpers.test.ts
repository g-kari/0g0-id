import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

vi.mock("@0g0-id/shared", () => ({
  findServiceById: vi.fn(),
  findUserById: vi.fn(),
}));

import { findServiceById, findUserById } from "@0g0-id/shared";
import {
  requireString,
  errorResponse,
  jsonResponse,
  textResponse,
  isErrorResponse,
  requireServiceValidation,
  requireUserValidation,
  isValidationError,
} from "./_helpers";
import type { McpToolResult } from "../mcp/server";

const mockFindServiceById = vi.mocked(findServiceById);
const mockFindUserById = vi.mocked(findUserById);
const mockDb = {} as D1Database;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("requireString", () => {
  it("有効な文字列を返す", () => {
    expect(requireString("hello", "name")).toBe("hello");
  });

  it("空文字列の場合エラーを返す", () => {
    const result = requireString("", "name");
    expect(result).toEqual({
      content: [{ type: "text", text: "name は必須です" }],
      isError: true,
    });
  });

  it("nullの場合エラーを返す", () => {
    const result = requireString(null, "field");
    expect(result).toEqual({
      content: [{ type: "text", text: "field は必須です" }],
      isError: true,
    });
  });

  it("undefinedの場合エラーを返す", () => {
    const result = requireString(undefined, "field");
    expect(result).toEqual({
      content: [{ type: "text", text: "field は必須です" }],
      isError: true,
    });
  });

  it("数値の場合エラーを返す", () => {
    const result = requireString(123, "field");
    expect(result).toEqual({
      content: [{ type: "text", text: "field は必須です" }],
      isError: true,
    });
  });

  it("booleanの場合エラーを返す", () => {
    const result = requireString(true, "field");
    expect(result).toEqual({
      content: [{ type: "text", text: "field は必須です" }],
      isError: true,
    });
  });
});

describe("errorResponse", () => {
  it("isError: true のレスポンスを返す", () => {
    expect(errorResponse("エラーです")).toEqual({
      content: [{ type: "text", text: "エラーです" }],
      isError: true,
    });
  });
});

describe("jsonResponse", () => {
  it("オブジェクトをJSON文字列に変換して返す", () => {
    const data = { id: "abc", name: "テスト" };
    const result = jsonResponse(data);
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    });
    expect(result.isError).toBeUndefined();
  });

  it("配列を変換できる", () => {
    const data = [1, 2, 3];
    const result = jsonResponse(data);
    expect(result.content[0].text).toBe(JSON.stringify(data, null, 2));
  });

  it("nullを変換できる", () => {
    const result = jsonResponse(null);
    expect(result.content[0].text).toBe("null");
  });
});

describe("textResponse", () => {
  it("テキストレスポンスを返す", () => {
    expect(textResponse("OK")).toEqual({
      content: [{ type: "text", text: "OK" }],
    });
  });

  it("isErrorが含まれない", () => {
    const result = textResponse("msg");
    expect(result.isError).toBeUndefined();
  });
});

describe("isErrorResponse", () => {
  it("文字列の場合falseを返す", () => {
    expect(isErrorResponse("valid")).toBe(false);
  });

  it("McpToolResultオブジェクトの場合trueを返す", () => {
    const result: McpToolResult = {
      content: [{ type: "text", text: "err" }],
      isError: true,
    };
    expect(isErrorResponse(result)).toBe(true);
  });

  it("isErrorなしのMcpToolResultでもtrueを返す", () => {
    const result: McpToolResult = {
      content: [{ type: "text", text: "ok" }],
    };
    expect(isErrorResponse(result)).toBe(true);
  });
});

describe("requireServiceValidation", () => {
  it("service_idが未指定の場合エラーを返す", async () => {
    const result = await requireServiceValidation({}, mockDb);
    expect(result).toEqual({
      content: [{ type: "text", text: "service_id は必須です" }],
      isError: true,
    });
  });

  it("service_idが空文字列の場合エラーを返す", async () => {
    const result = await requireServiceValidation({ service_id: "" }, mockDb);
    expect(result).toEqual({
      content: [{ type: "text", text: "service_id は必須です" }],
      isError: true,
    });
  });

  it("サービスが見つからない場合エラーを返す", async () => {
    mockFindServiceById.mockResolvedValue(null);
    const result = await requireServiceValidation({ service_id: "svc-1" }, mockDb);
    expect(result).toEqual({
      content: [{ type: "text", text: "サービスが見つかりません" }],
      isError: true,
    });
    expect(mockFindServiceById).toHaveBeenCalledWith(mockDb, "svc-1");
  });

  it("サービスが見つかった場合ValidatedServiceを返す", async () => {
    const service = { id: "svc-1", name: "Test Service" };
    mockFindServiceById.mockResolvedValue(service as Awaited<ReturnType<typeof findServiceById>>);
    const result = await requireServiceValidation({ service_id: "svc-1" }, mockDb);
    expect(result).toEqual({ serviceId: "svc-1", service });
  });
});

describe("requireUserValidation", () => {
  it("user_idが未指定の場合エラーを返す", async () => {
    const result = await requireUserValidation({}, mockDb);
    expect(result).toEqual({
      content: [{ type: "text", text: "user_id は必須です" }],
      isError: true,
    });
  });

  it("user_idが空文字列の場合エラーを返す", async () => {
    const result = await requireUserValidation({ user_id: "" }, mockDb);
    expect(result).toEqual({
      content: [{ type: "text", text: "user_id は必須です" }],
      isError: true,
    });
  });

  it("ユーザーが見つからない場合エラーを返す", async () => {
    mockFindUserById.mockResolvedValue(null);
    const result = await requireUserValidation({ user_id: "usr-1" }, mockDb);
    expect(result).toEqual({
      content: [{ type: "text", text: "ユーザーが見つかりません" }],
      isError: true,
    });
    expect(mockFindUserById).toHaveBeenCalledWith(mockDb, "usr-1");
  });

  it("ユーザーが見つかった場合ValidatedUserを返す", async () => {
    const user = { id: "usr-1", email: "test@example.com" };
    mockFindUserById.mockResolvedValue(user as Awaited<ReturnType<typeof findUserById>>);
    const result = await requireUserValidation({ user_id: "usr-1" }, mockDb);
    expect(result).toEqual({ userId: "usr-1", user });
  });
});

describe("isValidationError", () => {
  it("contentプロパティを持つオブジェクトの場合trueを返す", () => {
    const error: McpToolResult = {
      content: [{ type: "text", text: "err" }],
      isError: true,
    };
    expect(isValidationError(error)).toBe(true);
  });

  it("contentプロパティを持たないオブジェクトの場合falseを返す", () => {
    const valid = { serviceId: "svc-1", service: { id: "svc-1" } };
    expect(isValidationError(valid)).toBe(false);
  });

  it("文字列の場合TypeErrorをスローする", () => {
    expect(() => isValidationError("hello" as unknown as McpToolResult)).toThrow(TypeError);
  });

  it("数値の場合TypeErrorをスローする", () => {
    expect(() => isValidationError(42 as unknown as McpToolResult)).toThrow(TypeError);
  });
});
