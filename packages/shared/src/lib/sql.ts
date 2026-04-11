/**
 * SQL LIKE パターンのワイルドカード文字をエスケープする
 * ユーザー入力中の % や _ が LIKE のワイルドカードとして解釈されるのを防ぐ
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, "\\$&");
}
