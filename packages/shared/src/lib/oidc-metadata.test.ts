import { describe, it, expect } from "vite-plus/test";
import { buildBaseOidcMetadata, buildOpenIdConfiguration } from "./oidc-metadata";

const ISSUER = "https://id.0g0.xyz";

describe("buildBaseOidcMetadata", () => {
  const meta = buildBaseOidcMetadata(ISSUER);

  it("issuer がそのまま設定される", () => {
    expect(meta.issuer).toBe(ISSUER);
  });

  it("エンドポイントが issuer ベースの URL になる", () => {
    expect(meta.authorization_endpoint).toBe(`${ISSUER}/auth/authorize`);
    expect(meta.token_endpoint).toBe(`${ISSUER}/api/token`);
    expect(meta.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
    expect(meta.device_authorization_endpoint).toBe(`${ISSUER}/api/device/code`);
    expect(meta.revocation_endpoint).toBe(`${ISSUER}/api/token/revoke`);
    expect(meta.introspection_endpoint).toBe(`${ISSUER}/api/token/introspect`);
  });

  it("response_types_supported に code を含む", () => {
    expect(meta.response_types_supported).toContain("code");
  });

  it("grant_types_supported に authorization_code と refresh_token を含む", () => {
    expect(meta.grant_types_supported).toContain("authorization_code");
    expect(meta.grant_types_supported).toContain("refresh_token");
  });

  it("code_challenge_methods_supported に S256 を含む", () => {
    expect(meta.code_challenge_methods_supported).toContain("S256");
  });

  it("scopes_supported に openid を含む", () => {
    expect(meta.scopes_supported).toContain("openid");
  });

  it("subject_types_supported に pairwise を含む", () => {
    expect(meta.subject_types_supported).toContain("pairwise");
  });

  it("claims_supported に sub, iss, aud を含む", () => {
    expect(meta.claims_supported).toContain("sub");
    expect(meta.claims_supported).toContain("iss");
    expect(meta.claims_supported).toContain("aud");
  });
});

describe("buildOpenIdConfiguration", () => {
  const config = buildOpenIdConfiguration(ISSUER);

  it("base メタデータのフィールドを全て含む", () => {
    const base = buildBaseOidcMetadata(ISSUER);
    for (const key of Object.keys(base)) {
      expect(config).toHaveProperty(key);
    }
  });

  it("OpenID Connect 固有フィールドが追加されている", () => {
    expect(config.userinfo_endpoint).toBe(`${ISSUER}/api/userinfo`);
    expect(config.end_session_endpoint).toBe(`${ISSUER}/auth/logout`);
  });

  it("id_token_signing_alg_values_supported に ES256 を含む", () => {
    expect(config.id_token_signing_alg_values_supported).toContain("ES256");
  });

  it("異なる issuer で正しい URL が生成される", () => {
    const other = buildOpenIdConfiguration("https://auth.example.com");
    expect(other.issuer).toBe("https://auth.example.com");
    expect(other.token_endpoint).toBe("https://auth.example.com/api/token");
    expect(other.userinfo_endpoint).toBe("https://auth.example.com/api/userinfo");
  });
});
