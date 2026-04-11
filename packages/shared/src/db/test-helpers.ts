import { vi } from "vite-plus/test";

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
