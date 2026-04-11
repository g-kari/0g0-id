/**
 * OAuthプロバイダー定義の単一ソース。
 * プロバイダー名・DBカラム・表示名など、プロバイダーに関する定数は
 * すべてここで定義し、他のモジュールはここからインポートすること。
 */

/** サポートするOAuthプロバイダーの型 */
export type OAuthProvider = "google" | "line" | "twitch" | "github" | "x";

/** サポートするOAuthプロバイダーの一覧（イテレーション用） */
export const ALL_PROVIDERS: OAuthProvider[] = ["google", "line", "twitch", "github", "x"];

/** 文字列が有効なOAuthプロバイダーかどうかを検証する型ガード */
export function isValidProvider(value: string): value is OAuthProvider {
  return (ALL_PROVIDERS as readonly string[]).includes(value);
}

/** プロバイダーごとのUI表示名 */
export const PROVIDER_DISPLAY_NAMES: Record<OAuthProvider, string> = {
  google: "Google",
  line: "LINE",
  twitch: "Twitch",
  github: "GitHub",
  x: "X",
};

/** プロバイダーごとのDBカラム名 */
export const PROVIDER_COLUMN: Record<OAuthProvider, string> = {
  google: "google_sub",
  line: "line_sub",
  twitch: "twitch_sub",
  github: "github_sub",
  x: "x_sub",
};

/**
 * Google以外のオプションプロバイダーの環境変数名と表示名の定義。
 * 新しいプロバイダーを追加する際はここだけ更新すれば良い。
 */
export const PROVIDER_CREDENTIALS = {
  line: { id: "LINE_CLIENT_ID" as const, secret: "LINE_CLIENT_SECRET" as const, name: "LINE" },
  twitch: {
    id: "TWITCH_CLIENT_ID" as const,
    secret: "TWITCH_CLIENT_SECRET" as const,
    name: "Twitch",
  },
  github: {
    id: "GITHUB_CLIENT_ID" as const,
    secret: "GITHUB_CLIENT_SECRET" as const,
    name: "GitHub",
  },
  x: { id: "X_CLIENT_ID" as const, secret: "X_CLIENT_SECRET" as const, name: "X" },
} satisfies Record<Exclude<OAuthProvider, "google">, { id: string; secret: string; name: string }>;
