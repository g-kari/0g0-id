import { describe, it, expect, beforeEach, vi } from "vite-plus/test";
import { validateEnv, _resetValidationCache } from "./env-validation";
import type { IdpEnv } from "@0g0-id/shared";

const validEnv: Partial<IdpEnv> = {
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  JWT_PRIVATE_KEY: "mock-private-key",
  JWT_PUBLIC_KEY: "mock-public-key",
  IDP_ORIGIN: "https://id.0g0.xyz",
  USER_ORIGIN: "https://user.0g0.xyz",
  ADMIN_ORIGIN: "https://admin.0g0.xyz",
  COOKIE_SECRET: "a".repeat(32),
};

beforeEach(() => {
  _resetValidationCache();
});

describe("validateEnv", () => {
  it("有効な環境変数でok: trueを返す", () => {
    const result = validateEnv(validEnv as IdpEnv);
    expect(result.ok).toBe(true);
  });

  it("GOOGLE_CLIENT_IDが未設定の場合はエラーを返す", () => {
    const env = { ...validEnv, GOOGLE_CLIENT_ID: "" };
    const result = validateEnv(env as IdpEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("GOOGLE_CLIENT_ID"))).toBe(true);
    }
  });

  it("GOOGLE_CLIENT_SECRETが未設定の場合はエラーを返す", () => {
    const env = { ...validEnv, GOOGLE_CLIENT_SECRET: "" };
    const result = validateEnv(env as IdpEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("GOOGLE_CLIENT_SECRET"))).toBe(true);
    }
  });

  it("JWT_PRIVATE_KEYが未設定の場合はエラーを返す", () => {
    const env = { ...validEnv, JWT_PRIVATE_KEY: "" };
    const result = validateEnv(env as IdpEnv);
    expect(result.ok).toBe(false);
  });

  it("IDP_ORIGINが無効なURLの場合はエラーを返す", () => {
    const env = { ...validEnv, IDP_ORIGIN: "not-a-url" };
    const result = validateEnv(env as IdpEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("IDP_ORIGIN"))).toBe(true);
    }
  });

  it("COOKIE_SECRETが32文字未満の場合はエラーを返す", () => {
    const env = { ...validEnv, COOKIE_SECRET: "short" };
    const result = validateEnv(env as IdpEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("COOKIE_SECRET"))).toBe(true);
    }
  });

  it("COOKIE_SECRETがちょうど32文字の場合はエラーなし", () => {
    const env = { ...validEnv, COOKIE_SECRET: "a".repeat(32) };
    const result = validateEnv(env as IdpEnv);
    expect(result.ok).toBe(true);
  });

  it("LINE_CLIENT_IDのみ設定でLINE_CLIENT_SECRETが未設定の場合はエラー", () => {
    const env = { ...validEnv, LINE_CLIENT_ID: "line-id" } as IdpEnv;
    const result = validateEnv(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("LINE_CLIENT_SECRET"))).toBe(true);
    }
  });

  it("LINE_CLIENT_SECRETのみ設定でLINE_CLIENT_IDが未設定の場合はエラー", () => {
    const env = { ...validEnv, LINE_CLIENT_SECRET: "line-secret" } as IdpEnv;
    const result = validateEnv(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("LINE_CLIENT_ID"))).toBe(true);
    }
  });

  it("LINE_CLIENT_IDとLINE_CLIENT_SECRETが両方設定されていればエラーなし", () => {
    const env = {
      ...validEnv,
      LINE_CLIENT_ID: "line-id",
      LINE_CLIENT_SECRET: "line-secret",
    } as IdpEnv;
    const result = validateEnv(env);
    expect(result.ok).toBe(true);
  });

  it("GITHUB_CLIENT_IDのみ設定でエラーを返す", () => {
    const env = { ...validEnv, GITHUB_CLIENT_ID: "gh-id" } as IdpEnv;
    const result = validateEnv(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("GITHUB_CLIENT_SECRET"))).toBe(true);
    }
  });

  it("X_CLIENT_IDのみ設定でエラーを返す", () => {
    const env = { ...validEnv, X_CLIENT_ID: "x-id" } as IdpEnv;
    const result = validateEnv(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("X_CLIENT_SECRET"))).toBe(true);
    }
  });

  it("成功結果はキャッシュされ2回目以降は同じオブジェクトを返す", () => {
    const result1 = validateEnv(validEnv as IdpEnv);
    const result2 = validateEnv(validEnv as IdpEnv);
    expect(result1).toBe(result2);
  });

  it("失敗結果はキャッシュされない（環境変数修正後に回復できる）", () => {
    const badEnv = { ...validEnv, GOOGLE_CLIENT_ID: "" };
    const result1 = validateEnv(badEnv as IdpEnv);
    expect(result1.ok).toBe(false);

    // キャッシュされていないので2回目は別オブジェクト
    const result2 = validateEnv(badEnv as IdpEnv);
    expect(result1).not.toBe(result2);
  });

  it("_resetValidationCacheでキャッシュがリセットされる", () => {
    const result1 = validateEnv(validEnv as IdpEnv);
    expect(result1.ok).toBe(true);

    _resetValidationCache();

    // リセット後は新しいオブジェクトが返る
    const result2 = validateEnv(validEnv as IdpEnv);
    expect(result2.ok).toBe(true);
    expect(result1).not.toBe(result2);
  });

  describe("レートリミッター binding 警告", () => {
    const rateLimiterBindings = [
      "RATE_LIMITER_AUTH",
      "RATE_LIMITER_EXTERNAL",
      "RATE_LIMITER_TOKEN",
      "RATE_LIMITER_TOKEN_CLIENT",
      "RATE_LIMITER_DEVICE_VERIFY",
    ];

    it("本番環境でRATE_LIMITER未設定時にconsole.warnが呼ばれる", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // validEnv は IDP_ORIGIN が https:// なので本番扱い
      const result = validateEnv(validEnv as IdpEnv);
      expect(result.ok).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(rateLimiterBindings.length);
      for (const bindingName of rateLimiterBindings) {
        expect(warnSpy.mock.calls.some((call) => (call[0] as string).includes(bindingName))).toBe(
          true,
        );
      }
      warnSpy.mockRestore();
    });

    it("非本番環境ではconsole.warnが呼ばれない", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const devEnv = { ...validEnv, IDP_ORIGIN: "http://localhost:8787" };
      const result = validateEnv(devEnv as IdpEnv);
      expect(result.ok).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("本番環境でもvalidation結果はok: trueである（warningであってerrorではない）", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = validateEnv(validEnv as IdpEnv);
      expect(result.ok).toBe(true);
      warnSpy.mockRestore();
    });
  });
});
