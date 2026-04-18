import type { OAuthProvider } from "./lib/providers";

export interface User {
  id: string;
  google_sub: string | null;
  line_sub: string | null;
  twitch_sub: string | null;
  github_sub: string | null;
  x_sub: string | null;
  email: string;
  email_verified: number;
  name: string;
  picture: string | null;
  phone: string | null;
  address: string | null;
  role: "user" | "admin";
  banned_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Service {
  id: string;
  name: string;
  client_id: string;
  client_secret_hash: string;
  allowed_scopes: string;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface ServiceRedirectUri {
  id: string;
  service_id: string;
  uri: string;
  created_at: string;
}

export interface LoginEvent {
  id: string;
  user_id: string;
  provider: string;
  ip_address: string | null;
  user_agent: string | null;
  country: string | null;
  created_at: string;
}

export interface AuthCode {
  id: string;
  user_id: string;
  service_id: string | null;
  code_hash: string;
  redirect_to: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
  nonce: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  scope: string | null;
  provider: string | null;
}

export interface RefreshToken {
  id: string;
  user_id: string;
  service_id: string | null;
  token_hash: string;
  family_id: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  scope: string | null;
  pairwise_sub: string | null;
  expires_at: string;
  created_at: string;
}

export interface AdminAuditLog {
  id: string;
  admin_user_id: string;
  action: string;
  target_type: string;
  target_id: string;
  details: string | null;
  ip_address: string | null;
  status: "success" | "failure";
  created_at: string;
}

export interface TokenPayload {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  kid: string;
  email: string;
  role: "user" | "admin";
  /** OIDCスコープ（スペース区切り）。サービストークンのみ設定される。BFFセッションはundefined。 */
  scope?: string;
  /** トークンを発行したサービスのclient_id。サービストークンのみ設定される。BFFセッションはundefined。 */
  cid?: string;
}

/**
 * Cloudflare Workers Rate Limiting API のバインディング型。
 * `limit()` は key ごとのリクエスト数が制限内なら { success: true } を返す。
 */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface IdpEnv {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  LINE_CLIENT_ID?: string;
  LINE_CLIENT_SECRET?: string;
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  JWT_PRIVATE_KEY: string;
  JWT_PUBLIC_KEY: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
  IDP_ORIGIN: string;
  USER_ORIGIN: string;
  ADMIN_ORIGIN: string;
  /** 追加BFFオリジン（カンマ区切り）。例: "https://rss.0g0.xyz,https://app.0g0.xyz" */
  EXTRA_BFF_ORIGINS?: string;
  /** state/PKCE Cookie の HMAC-SHA256 署名シークレット */
  COOKIE_SECRET: string;
  /** /auth/login, /auth/callback 向けレートリミッター（IP単位） */
  RATE_LIMITER_AUTH?: RateLimitBinding;
  /** /api/external/*, /api/token/introspect, /api/userinfo 向けレートリミッター（client_id単位、未取得時はIP） */
  RATE_LIMITER_EXTERNAL?: RateLimitBinding;
  /** /auth/exchange, /auth/refresh 向けレートリミッター（IP単位） */
  RATE_LIMITER_TOKEN?: RateLimitBinding;
  /** /api/device/verify 向けレートリミッター（認証ユーザー単位） */
  RATE_LIMITER_DEVICE_VERIFY?: RateLimitBinding;
  /** /api/token POST 向けレートリミッター（client_id単位、未取得時はIP） */
  RATE_LIMITER_TOKEN_CLIENT?: RateLimitBinding;
  /**
   * BFF→IdP 間の内部シークレット（後方互換フォールバック）。
   * BFF 毎の個別シークレット（INTERNAL_SERVICE_SECRET_USER / _ADMIN）が優先される。issue #156。
   */
  INTERNAL_SERVICE_SECRET?: string;
  /** user BFF 専用の内部シークレット。未設定時は INTERNAL_SERVICE_SECRET にフォールバック。 */
  INTERNAL_SERVICE_SECRET_USER?: string;
  /** admin BFF 専用の内部シークレット。未設定時は INTERNAL_SERVICE_SECRET にフォールバック。 */
  INTERNAL_SERVICE_SECRET_ADMIN?: string;
}

export interface BffEnv {
  IDP: Fetcher;
  IDP_ORIGIN: string;
  /** BFF自身のオリジン（例: "https://user.0g0.xyz"）。CORS/CSRF検証に使用。 */
  SELF_ORIGIN: string;
  /** BFFセッションCookieのAES-GCM暗号化キー */
  SESSION_SECRET: string;
  /**
   * 共有シークレット（後方互換フォールバック）。
   * 個別 BFF で INTERNAL_SERVICE_SECRET_SELF が設定されていればそちらを優先する。
   */
  INTERNAL_SERVICE_SECRET?: string;
  /**
   * この BFF 専用の内部シークレット（推奨）。
   * 設定されていれば INTERNAL_SERVICE_SECRET より優先される。BFF 毎の独立ローテーションを可能にする（issue #156）。
   */
  INTERNAL_SERVICE_SECRET_SELF?: string;
}

/**
 * OAuth認可フロー中にCookieで保持するstateデータの型。
 * `/auth/login` でJSON.stringifyして保存し、`/auth/callback` でパースして利用する。
 */
export interface OAuthStateCookieData {
  idState: string;
  bffState: string;
  redirectTo: string;
  provider: OAuthProvider;
  linkUserId?: string;
  serviceId?: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope?: string;
}
