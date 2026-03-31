/**
 * 指定した日数前の日時を ISO 8601 文字列で返す。
 * DB の `WHERE created_at >= ?` 等の時間窓フィルタに使用する。
 *
 * @param days - 遡る日数
 * @param now  - 基準時刻（ミリ秒 UNIX タイムスタンプ）。省略時は現在時刻。
 */
export function daysAgoIso(days: number, now: number = Date.now()): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}
