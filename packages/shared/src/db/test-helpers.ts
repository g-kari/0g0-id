import { vi } from "vite-plus/test";
import type { IdpEnv } from "../types";

/**
 * D1Databaseのモックを生成するテストユーティリティ
 *
 * @param firstResult - first() の返り値（デフォルト: null）
 * @param allResults - all() の返り値の results 配列（デフォルト: []）
 * @param changes - run() のメタデータ changes 値（デフォルト: 1）
 */
export function makeD1Mock(
  firstResult: unknown = null,
  allResults: unknown[] = [],
  changes = 1,
): D1Database & { _stmt: ReturnType<typeof vi.fn> } {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstResult),
    run: vi.fn().mockResolvedValue({ meta: { changes } }),
    all: vi.fn().mockResolvedValue({ results: allResults }),
  };
  const db = { prepare: vi.fn().mockReturnValue(stmt), _stmt: stmt };
  return db as unknown as D1Database & { _stmt: ReturnType<typeof vi.fn> };
}

/**
 * 型安全なIdpEnvモックを生成するテストユーティリティ。
 * 必須フィールドにはデフォルト値が設定され、overridesで上書き可能。
 * 返り値はIdpEnv型なので app.request() に直接渡せる（as unknown as 不要）。
 */
export function createMockIdpEnv(overrides: Partial<IdpEnv> = {}): IdpEnv {
  return {
    DB: {} as D1Database,
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    JWT_PRIVATE_KEY: "mock-private-key",
    JWT_PUBLIC_KEY: "mock-public-key",
    IDP_ORIGIN: "https://id.0g0.xyz",
    USER_ORIGIN: "https://user.0g0.xyz",
    ADMIN_ORIGIN: "https://admin.0g0.xyz",
    COOKIE_SECRET: "test-cookie-secret-32chars-long!!",
    ...overrides,
  };
}
