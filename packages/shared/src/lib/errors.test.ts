import { describe, it, expect } from "vite-plus/test";
import { REST_ERROR_CODES, restErrorBody, oauthErrorBody } from "./errors";

describe("REST_ERROR_CODES", () => {
  it("全コードがキーと値で一致する", () => {
    for (const [key, value] of Object.entries(REST_ERROR_CODES)) {
      expect(key).toBe(value);
    }
  });

  it("必須コードが含まれている", () => {
    const required = ["BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "INTERNAL_ERROR"];
    for (const code of required) {
      expect(REST_ERROR_CODES).toHaveProperty(code);
    }
  });
});

describe("restErrorBody", () => {
  it("REST API 形式のエラーボディを生成する", () => {
    const body = restErrorBody("NOT_FOUND", "User not found");
    expect(body).toEqual({
      error: { code: "NOT_FOUND", message: "User not found" },
    });
  });

  it("カスタムコードも受け付ける", () => {
    const body = restErrorBody("TOKEN_ROTATED", "Token was rotated");
    expect(body.error.code).toBe("TOKEN_ROTATED");
  });

  it("空文字でも構造は正しい", () => {
    const body = restErrorBody("", "");
    expect(body).toEqual({ error: { code: "", message: "" } });
  });
});

describe("oauthErrorBody", () => {
  it("description 付きのエラーボディを生成する", () => {
    const body = oauthErrorBody("invalid_request", "client_id is required");
    expect(body).toEqual({
      error: "invalid_request",
      error_description: "client_id is required",
    });
  });

  it("description なしの場合は error のみ", () => {
    const body = oauthErrorBody("server_error");
    expect(body).toEqual({ error: "server_error" });
    expect(body).not.toHaveProperty("error_description");
  });

  it("description が undefined の場合は error のみ", () => {
    const body = oauthErrorBody("invalid_grant", undefined);
    expect(body).toEqual({ error: "invalid_grant" });
    expect(body).not.toHaveProperty("error_description");
  });
});
