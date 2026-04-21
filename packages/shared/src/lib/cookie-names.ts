/**
 * Cookie名定数。
 * 全workerで使うCookie名をここに集約し、文字列リテラルの散在を防ぐ。
 */

export const COOKIE_NAMES = {
  ADMIN_SESSION: "__Host-admin-session",
  ADMIN_STATE: "__Host-admin-oauth-state",
  USER_SESSION: "__Host-user-session",
  USER_STATE: "__Host-user-oauth-state",
  IDP_STATE: "__Host-oauth-state",
  IDP_PKCE: "__Host-oauth-pkce",
} as const;
