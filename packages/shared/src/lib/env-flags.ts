/**
 * Workers secret / env var に「strict 有効化フラグ」相当の文字列が設定されたか判定する汎用ヘルパ。
 *
 * 受理規則: `trim().toLowerCase() === "true"` のみ。`"1"` / `"yes"` / `"on"` 等は受理しない。
 *
 * 設計意図:
 * - secrets-store UI のコピペで trailing space / 大文字が混入しても黙ってフェイルオープン（＝ strict 無効のまま）にならない
 * - 逆に `"1"` / `"yes"` 等の「それっぽい値」で意図せず strict に入って本番サービス断にならない
 * - 複数機能（`DBSC_ENFORCE_SENSITIVE` 等）で同じ受理規則を共有し、
 *   secret 管理者が値の意味を機能ごとに覚え直す必要をなくす
 *
 * 個別機能のドメイン用語が付いた薄いラッパ（例: `isDbscEnforceValue`）から
 * この関数へ委譲することで、判定規則の単一ソース化と命名の明確化を両立する。
 */
export function parseStrictBoolEnv(raw: string | undefined | null): boolean {
  return (
    String(raw ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}
