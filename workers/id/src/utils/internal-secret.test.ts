import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

vi.mock("@0g0-id/shared", () => ({
  timingSafeEqual: vi.fn(),
  // isInternalSecretStrict は parseStrictBoolEnv に委譲するため、本物の実装をそのまま公開する。
  // 純粋関数で副作用ゼロのためモック不要。
  parseStrictBoolEnv: (raw: string | undefined | null): boolean =>
    String(raw ?? "")
      .trim()
      .toLowerCase() === "true",
}));

import { timingSafeEqual } from "@0g0-id/shared";
import type { IdpEnv } from "@0g0-id/shared";
import {
  classifyInternalSecret,
  getConfiguredInternalSecrets,
  hasValidInternalSecret,
  INTERNAL_SECRET_HEADER,
  isInternalSecretStrict,
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

describe("classifyInternalSecret", () => {
  beforeEach(() => {
    vi.mocked(timingSafeEqual).mockReset();
  });

  it("ヘッダー未設定なら 'none' を返す（timingSafeEqual は呼ばれない）", () => {
    const env = envWith({ INTERNAL_SERVICE_SECRET: "s" });
    expect(classifyInternalSecret(env, reqWith())).toBe("none");
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it("シークレット未設定なら 'none'", () => {
    expect(classifyInternalSecret(envWith({}), reqWith("anything"))).toBe("none");
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it("USER シークレットに一致すれば 'user' を返し、以降は照合しない", () => {
    vi.mocked(timingSafeEqual).mockReturnValueOnce(true);
    const env = envWith({
      INTERNAL_SERVICE_SECRET_USER: "user-secret",
      INTERNAL_SERVICE_SECRET_ADMIN: "admin-secret",
      INTERNAL_SERVICE_SECRET: "shared-secret",
    });
    expect(classifyInternalSecret(env, reqWith("user-secret"))).toBe("user");
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it("ADMIN シークレットに一致すれば 'admin' を返す（USER を先に照合してから）", () => {
    vi.mocked(timingSafeEqual).mockReturnValueOnce(false).mockReturnValueOnce(true);
    const env = envWith({
      INTERNAL_SERVICE_SECRET_USER: "user-secret",
      INTERNAL_SERVICE_SECRET_ADMIN: "admin-secret",
      INTERNAL_SERVICE_SECRET: "shared-secret",
    });
    expect(classifyInternalSecret(env, reqWith("admin-secret"))).toBe("admin");
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
  });

  it("共有シークレットに一致すれば 'shared' を返す（USER・ADMIN を先に照合してから）", () => {
    vi.mocked(timingSafeEqual)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const env = envWith({
      INTERNAL_SERVICE_SECRET_USER: "user-secret",
      INTERNAL_SERVICE_SECRET_ADMIN: "admin-secret",
      INTERNAL_SERVICE_SECRET: "shared-secret",
    });
    expect(classifyInternalSecret(env, reqWith("shared-secret"))).toBe("shared");
    expect(timingSafeEqual).toHaveBeenCalledTimes(3);
  });

  it("空文字シークレットはスキップされる（timingSafeEqual は呼ばれない）", () => {
    vi.mocked(timingSafeEqual).mockReturnValueOnce(true);
    const env = envWith({
      INTERNAL_SERVICE_SECRET_USER: "",
      INTERNAL_SERVICE_SECRET_ADMIN: "admin-secret",
    });
    expect(classifyInternalSecret(env, reqWith("admin-secret"))).toBe("admin");
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it("どのシークレットにも一致しなければ 'none'（全候補を照合）", () => {
    vi.mocked(timingSafeEqual).mockReturnValue(false);
    const env = envWith({
      INTERNAL_SERVICE_SECRET_USER: "user-secret",
      INTERNAL_SERVICE_SECRET_ADMIN: "admin-secret",
      INTERNAL_SERVICE_SECRET: "shared-secret",
    });
    expect(classifyInternalSecret(env, reqWith("wrong"))).toBe("none");
    expect(timingSafeEqual).toHaveBeenCalledTimes(3);
  });
});

describe("isInternalSecretStrict", () => {
  it("未設定なら false", () => {
    expect(isInternalSecretStrict(envWith({}))).toBe(false);
  });

  it("'true' なら true", () => {
    expect(isInternalSecretStrict(envWith({ INTERNAL_SECRET_STRICT: "true" }))).toBe(true);
  });

  it("大文字・前後空白混入でも true（secrets-store UI のコピペ耐性）", () => {
    expect(isInternalSecretStrict(envWith({ INTERNAL_SECRET_STRICT: "TRUE" }))).toBe(true);
    expect(isInternalSecretStrict(envWith({ INTERNAL_SECRET_STRICT: "True" }))).toBe(true);
    expect(isInternalSecretStrict(envWith({ INTERNAL_SECRET_STRICT: "  true  " }))).toBe(true);
    expect(isInternalSecretStrict(envWith({ INTERNAL_SECRET_STRICT: "\ttrue\n" }))).toBe(true);
  });

  it("'1' / 'yes' / 'on' / 'enable' は false（明示的に 'true' 文字列のみ受理）", () => {
    expect(isInternalSecretStrict(envWith({ INTERNAL_SECRET_STRICT: "1" }))).toBe(false);
    expect(isInternalSecretStrict(envWith({ INTERNAL_SECRET_STRICT: "yes" }))).toBe(false);
    expect(isInternalSecretStrict(envWith({ INTERNAL_SECRET_STRICT: "on" }))).toBe(false);
    expect(isInternalSecretStrict(envWith({ INTERNAL_SECRET_STRICT: "enable" }))).toBe(false);
  });

  it("空文字は false", () => {
    expect(isInternalSecretStrict(envWith({ INTERNAL_SECRET_STRICT: "" }))).toBe(false);
  });

  it("false 相当の値（'false' / 'no' / '0'）は false", () => {
    expect(isInternalSecretStrict(envWith({ INTERNAL_SECRET_STRICT: "false" }))).toBe(false);
    expect(isInternalSecretStrict(envWith({ INTERNAL_SECRET_STRICT: "no" }))).toBe(false);
    expect(isInternalSecretStrict(envWith({ INTERNAL_SECRET_STRICT: "0" }))).toBe(false);
  });
});
