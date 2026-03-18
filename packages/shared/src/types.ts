export interface User {
  id: string;
  google_sub: string;
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

export interface AuthCode {
  id: string;
  user_id: string;
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

export interface IdpEnv {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  JWT_PRIVATE_KEY: string;
  JWT_PUBLIC_KEY: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
  IDP_ORIGIN: string;
  USER_ORIGIN: string;
  ADMIN_ORIGIN: string;
}

export interface BffEnv {
  IDP: Fetcher;
  IDP_ORIGIN: string;
}
