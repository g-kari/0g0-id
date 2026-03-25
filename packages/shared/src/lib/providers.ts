/**
 * OAuthプロバイダー定義の単一ソース。
 * プロバイダー名・DBカラム・表示名など、プロバイダーに関する定数は
 * すべてここで定義し、他のモジュールはここからインポートすること。
 */

/** サポートするOAuthプロバイダーの型 */
export type OAuthProvider = 'google' | 'line' | 'twitch' | 'github' | 'x';

/** サポートするOAuthプロバイダーの一覧（イテレーション用） */
export const ALL_PROVIDERS: OAuthProvider[] = ['google', 'line', 'twitch', 'github', 'x'];

/** プロバイダーごとのUI表示名 */
export const PROVIDER_DISPLAY_NAMES: Record<OAuthProvider, string> = {
  google: 'Google',
  line: 'LINE',
  twitch: 'Twitch',
  github: 'GitHub',
  x: 'X',
};

/** プロバイダーごとのDBカラム名 */
export const PROVIDER_COLUMN: Record<OAuthProvider, string> = {
  google: 'google_sub',
  line: 'line_sub',
  twitch: 'twitch_sub',
  github: 'github_sub',
  x: 'x_sub',
};
