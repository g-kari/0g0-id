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
  role: 'user' | 'admin';
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
}

export interface RefreshToken {
  id: string;
  user_id: string;
  service_id: string | null;
  token_hash: string;
  family_id: string;
  revoked_at: string | null;
  expires_at: string;
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
  role: 'user' | 'admin';
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
  /** /auth/login, /auth/callback 向けレートリミッター（IP単位） */
  RATE_LIMITER_AUTH?: RateLimitBinding;
  /** /api/external/*, /api/token/introspect 向けレートリミッター（client_id単位） */
  RATE_LIMITER_EXTERNAL?: RateLimitBinding;
}

export interface BffEnv {
  IDP: Fetcher;
  IDP_ORIGIN: string;
}
