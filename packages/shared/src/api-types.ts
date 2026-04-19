/**
 * API レスポンス型定義
 *
 * IdP が返す JSON の `data` フィールドの型。
 * フロントエンド（user/admin）とバックエンド（IdP）の両方から参照し、
 * インターフェースの乖離を防ぐ。
 *
 * ⚠ このファイルは外部パッケージに依存しないこと。
 *   フロントエンド(Astro)から直接 import されるため、
 *   hono 等の依存が存在しない環境でも解決できる必要がある。
 */

// ─── User 系 ────────────────────────────────────────────

/** GET /api/me — ユーザー自身のプロフィール */
export interface MyProfile {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  phone: string | null;
  address: string | null;
  role: "admin" | "user";
}

/** 管理者向けユーザーサマリー（GET /api/users 一覧） */
export interface AdminUserSummary {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  role: "admin" | "user";
  banned_at: string | null;
  created_at: string;
}

// ─── Metrics 系 ──────────────────────────────────────────

/** ログインプロバイダー統計 */
export interface ProviderStat {
  provider: string;
  count: number;
}

/** ログイン国別統計 */
export interface CountryStat {
  country: string;
  count: number;
}

/** GET /api/metrics — 管理ダッシュボード概況 */
export interface AdminMetrics {
  total_users: number;
  admin_users: number;
  banned_users: number;
  total_services: number;
  active_sessions: number;
  recent_logins_24h: number;
  recent_logins_7d: number;
  login_provider_stats_7d: ProviderStat[];
  login_country_stats_7d: CountryStat[];
}

// ─── Service 系 ──────────────────────────────────────────

/** サービス一覧の各要素（GET /api/services） */
export interface ServiceSummary {
  id: string;
  name: string;
  client_id: string;
  allowed_scopes: string;
  owner_user_id: string;
  created_at: string;
}

/** サービス新規作成レスポンス（POST /api/services） — client_secret は作成時のみ */
export interface NewServiceResult {
  id: string;
  name: string;
  client_id: string;
  client_secret: string;
  allowed_scopes: string;
  created_at: string;
}

// ─── Provider / Connection / Session 系 ──────────────────
// ProviderStatus, UserConnection, ActiveSession は DB 層で定義済み（API互換）。
// フロントエンドから api-types 経由でアクセスできるよう re-export する。
// ※ index.ts で DB モジュールも export * しているため、
//    名前衝突を避けるために export type（非 re-export）は使わない。
//    フロントエンドは tsconfig paths / Vite alias で直接このファイルを参照するため、
//    index.ts 経由ではなくローカル re-export が必要。
export type { ProviderStatus } from "./db/users";
export type { UserConnection, ActiveSession } from "./db/refresh-tokens";
export type { ActiveBffSessionSummary, BffSessionDbscStats } from "./db/bff-sessions";
export type { LoginProviderStat, DailyLoginStat } from "./db/login-events";
export type { LoginEvent } from "./types";
