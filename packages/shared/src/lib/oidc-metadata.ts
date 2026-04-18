/**
 * OIDC / OAuth 2.0 メタデータビルダー
 *
 * RFC 8414 (OAuth Authorization Server Metadata) と OIDC Discovery 1.0 で
 * 返すメタデータを構築する。Worker のランタイム応答とビルド時の静的JSON生成
 * （workers/id/scripts/build-assets.ts）で共通利用するため shared に配置。
 */

export interface BaseOidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  scopes_supported: string[];
  response_types_supported: string[];
  response_modes_supported: string[];
  grant_types_supported: string[];
  subject_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  device_authorization_endpoint: string;
  revocation_endpoint: string;
  introspection_endpoint: string;
  claims_supported: string[];
}

export interface OpenIdConfiguration extends BaseOidcMetadata {
  userinfo_endpoint: string;
  end_session_endpoint: string;
  id_token_signing_alg_values_supported: string[];
}

export function buildBaseOidcMetadata(issuer: string): BaseOidcMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/auth/authorize`,
    token_endpoint: `${issuer}/api/token`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    scopes_supported: ["openid", "profile", "email", "phone", "address"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    subject_types_supported: ["pairwise"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
    code_challenge_methods_supported: ["S256"],
    device_authorization_endpoint: `${issuer}/api/device/code`,
    revocation_endpoint: `${issuer}/api/token/revoke`,
    introspection_endpoint: `${issuer}/api/token/introspect`,
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "name",
      "picture",
      "email",
      "email_verified",
      "phone_number",
      "address",
      "updated_at",
      "amr",
    ],
  };
}

export function buildOpenIdConfiguration(issuer: string): OpenIdConfiguration {
  return {
    ...buildBaseOidcMetadata(issuer),
    userinfo_endpoint: `${issuer}/api/userinfo`,
    end_session_endpoint: `${issuer}/auth/logout`,
    id_token_signing_alg_values_supported: ["ES256"],
  };
}
