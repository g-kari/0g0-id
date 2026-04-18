import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

vi.mock("@0g0-id/shared", () => ({
  timingSafeEqual: vi.fn(),
}));

import { timingSafeEqual } from "@0g0-id/shared";
import type { IdpEnv } from "@0g0-id/shared";
import {
  getConfiguredInternalSecrets,
  hasValidInternalSecret,
  INTERNAL_SECRET_HEADER,
} from "./internal-secret";

function envWith(overrides: Partial<IdpEnv>): IdpEnv {
  return overrides as IdpEnv;
}

function reqWith(headerValue?: string): Request {
  const headers = new Headers();
  if (headerValue !== undefined) headers.set(INTERNAL_SECRET_HEADER, headerValue);
  return new Request("https://id.0g0.xyz/auth/exchange", { method: "POST", headers });
}

describe("getConfiguredInternalSecrets", () => {
  it("設定済みシークレットを USER → ADMIN → 共有 の順で返す", () => {
    const env = envWith({
      INTERNAL_SERVICE_SECRET_USER: "user-secret",
      INTERNAL_SERVICE_SECRET_ADMIN: "admin-secret",
      INTERNAL_SERVICE_SECRET: "shared-secret",
    });
    expect(getConfiguredInternalSecrets(env)).toEqual([
      "user-secret",
      "admin-secret",
      "shared-secret",
    ]);
  });

  it("未設定・空文字は除外される", () => {
    const env = envWith({
      INTERNAL_SERVICE_SECRET_USER: "user-secret",
      INTERNAL_SERVICE_SECRET_ADMIN: "",
    });
    expect(getConfiguredInternalSecrets(env)).toEqual(["user-secret"]);
  });

  it("全て未設定なら空配列", () => {
    expect(getConfiguredInternalSecrets(envWith({}))).toEqual([]);
  });
});

describe("hasValidInternalSecret", () => {
  beforeEach(() => {
    vi.mocked(timingSafeEqual).mockReset();
  });

  it("ヘッダー未設定なら false（timingSafeEqual は呼ばれない）", () => {
    const env = envWith({ INTERNAL_SERVICE_SECRET: "s" });
    expect(hasValidInternalSecret(env, reqWith())).toBe(false);
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it("シークレット未設定なら false", () => {
    expect(hasValidInternalSecret(envWith({}), reqWith("anything"))).toBe(false);
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it("いずれかのシークレットに一致すれば true（早期 return で残りは照合しない）", () => {
    vi.mocked(timingSafeEqual).mockReturnValueOnce(false).mockReturnValueOnce(true);
    const env = envWith({
      INTERNAL_SERVICE_SECRET_USER: "user-secret",
      INTERNAL_SERVICE_SECRET_ADMIN: "admin-secret",
      INTERNAL_SERVICE_SECRET: "shared-secret",
    });
    expect(hasValidInternalSecret(env, reqWith("admin-secret"))).toBe(true);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
  });

  it("どのシークレットにも一致しなければ全て照合して false", () => {
    vi.mocked(timingSafeEqual).mockReturnValue(false);
    const env = envWith({
      INTERNAL_SERVICE_SECRET_USER: "user-secret",
      INTERNAL_SERVICE_SECRET_ADMIN: "admin-secret",
      INTERNAL_SERVICE_SECRET: "shared-secret",
    });
    expect(hasValidInternalSecret(env, reqWith("wrong"))).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(3);
  });
});
