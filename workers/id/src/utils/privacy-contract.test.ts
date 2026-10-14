import { describe, it, expect, vi } from "vite-plus/test";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { IdpEnv, User } from "@0g0-id/shared";

// Only the database insertion is stubbed. Signing and JWKS verification are real.
// The keys below are the existing public-repository TEST fixture, not production credentials.
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return { ...actual, createRefreshToken: vi.fn().mockResolvedValue(undefined) };
});

import {
  createRefreshToken,
  createRelyingPartyClaims,
  createLegacyRelyingPartyUser,
  generatePairwiseSub,
  getJWTKeys,
  getJWKS,
  signIdToken,
  signAccessToken,
} from "@0g0-id/shared";
import { issueTokenPair, issueIdToken } from "./token-pair";

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgrZghEEi6BBGwfZOq
xDomoXNlA2LXvkC4tK5iqkDMrA+hRANCAARj8giy/uqZi4CF/nz5E3NzoFpAaLNx
JX+ypi6Oipzku2j0lTUIHLNtV9vVZX8kCaETTWLjaypsISdu9M8dKazX
-----END PRIVATE KEY-----`;

const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY/IIsv7qmYuAhf58+RNzc6BaQGiz
cSV/sqYujoqc5Lto9JU1CByzbVfb1WV/JAmhE01i42sqbCEnbvTPHSms1w==
-----END PUBLIC KEY-----`;

const syntheticUser: User = {
  id: "synthetic-internal-user-id",
  google_sub: "synthetic-google-sub",
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: "pii-canary@example.invalid",
  email_verified: 1,
  name: "Synthetic PII Canary",
  picture: "https://example.invalid/pii-canary.png",
  phone: "+00-000-000-000",
  address: "Synthetic Address Canary",
  role: "admin",
  banned_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const env = {
  DB: {} as D1Database,
  IDP_ORIGIN: "https://id.example.invalid",
  JWT_PRIVATE_KEY: TEST_PRIVATE_KEY,
  JWT_PUBLIC_KEY: TEST_PUBLIC_KEY,
  PAIRWISE_SALT: "synthetic-test-only-pairwise-salt",
} as IdpEnv;

const profileFields = [
  "email", "email_verified", "name", "picture", "phone", "phone_number",
  "address", "role", "google_sub", "line_sub", "twitch_sub", "github_sub", "x_sub",
];

function assertNoProfile(claims: Record<string, unknown>): void {
  for (const field of profileFields) expect(claims).not.toHaveProperty(field);
  for (const value of [syntheticUser.email, syntheticUser.name, syntheticUser.phone, syntheticUser.address]) {
    expect(Object.values(claims)).not.toContain(value);
  }
}

async function verify(token: string, audience: string): ReturnType<typeof jwtVerify> {
  const { kid } = await getJWTKeys(TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
  const keys = await getJWKS(TEST_PUBLIC_KEY, kid);
  return jwtVerify(token, createLocalJWKSet(keys as JSONWebKeySet), {
    issuer: env.IDP_ORIGIN,
    audience,
    algorithms: ["ES256"],
  });
}

describe("RP privacy contract with synthetic data and real ES256/JWKS", () => {
  for (const scope of ["openid", "openid profile email phone address", "openid invalid"]) {
    it(`ID token ignores requested profile scopes: ${scope}`, async () => {
      const service = { client_id: "synthetic-client-a" };
      const token = await issueIdToken(env, syntheticUser, service, scope, {
        nonce: "synthetic-nonce",
        amr: ["google"],
      });
      expect(token).toBeDefined();
      const { payload, protectedHeader } = await verify(token!, service.client_id);
      assertNoProfile(payload);
      expect(payload.nonce).toBe("synthetic-nonce");
      expect(payload.amr).toBeUndefined();
      expect(protectedHeader.alg).toBe("ES256");
      expect(payload.sub).toBe(await generatePairwiseSub(service.client_id, syntheticUser.id, env.PAIRWISE_SALT));
      await expect(verify(token!, "synthetic-client-b")).rejects.toThrow();
    });
  }

  it("pairwise values stay stable for the same client and differ across clients", async () => {
    const a = await issueIdToken(env, syntheticUser, { client_id: "synthetic-client-a" }, "openid");
    const again = await issueIdToken(env, syntheticUser, { client_id: "synthetic-client-a" }, "openid");
    const b = await issueIdToken(env, syntheticUser, { client_id: "synthetic-client-b" }, "openid");
    const av = await verify(a!, "synthetic-client-a");
    const aav = await verify(again!, "synthetic-client-a");
    const bv = await verify(b!, "synthetic-client-b");
    expect(av.payload.sub).toBe(aav.payload.sub);
    expect(av.payload.sub).not.toBe(bv.payload.sub);
    expect(av.payload.sub).not.toBe(syntheticUser.id);
  });

  it("service access token omits profile and admin role while retaining the deferred internal-sub contract", async () => {
    vi.mocked(createRefreshToken).mockClear();
    const pair = await issueTokenPair(env.DB, env, syntheticUser, {
      serviceId: "synthetic-service-a", clientId: "synthetic-client-a", scope: "openid",
    });
    const { payload } = await verify(pair.accessToken, "synthetic-client-a");
    assertNoProfile(payload);
    // Known residual: removing this UUID requires coordinated subject lookup/audience changes.
    expect(payload.sub).toBe(syntheticUser.id);
    expect(payload.cid).toBe("synthetic-client-a");
    expect(createRefreshToken).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        pairwiseSub: await generatePairwiseSub("synthetic-client-a", syntheticUser.id, env.PAIRWISE_SALT),
      }),
    );
  });

  it("a serviceId without clientId cannot silently issue a BFF-shaped token", async () => {
    vi.mocked(createRefreshToken).mockClear();
    await expect(issueTokenPair(env.DB, env, syntheticUser, { serviceId: "synthetic-service-a" })).rejects.toThrow();
    await expect(issueTokenPair(env.DB, env, syntheticUser, { serviceId: null, clientId: "synthetic-client-a" })).rejects.toThrow();
    await expect(issueTokenPair(env.DB, env, syntheticUser, { serviceId: "synthetic-service-a", clientId: "" })).rejects.toThrow();
    expect(createRefreshToken).not.toHaveBeenCalled();
  });

  it("direct ID signer cannot reintroduce legacy profile parameters", async () => {
    const token = await signIdToken({
      iss: env.IDP_ORIGIN, aud: "synthetic-client-a", sub: "b".repeat(64),
      email: syntheticUser.email, name: syntheticUser.name, picture: syntheticUser.picture,
      authTime: 1_700_000_000,
    }, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    assertNoProfile((await verify(token, "synthetic-client-a")).payload);
  });

  it("direct RP access signer suppresses profile/admin role even with profile scopes", async () => {
    const token = await signAccessToken({
      iss: env.IDP_ORIGIN, aud: "synthetic-client-a", sub: syntheticUser.id,
      email: syntheticUser.email, role: syntheticUser.role,
      cid: "synthetic-client-a", scope: "openid profile email phone address",
    }, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    assertNoProfile((await verify(token, "synthetic-client-a")).payload);
  });

  it("BFF access-token profile/role contract is preserved for the separate migration", async () => {
    const token = await signAccessToken({
      iss: env.IDP_ORIGIN, aud: env.IDP_ORIGIN, sub: syntheticUser.id,
      email: syntheticUser.email, role: syntheticUser.role,
    }, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    const { payload } = await verify(token, env.IDP_ORIGIN);
    expect(payload.email).toBe(syntheticUser.email);
    expect(payload.role).toBe("admin");
  });

  it("projections only accept a precomputed subject", () => {
    expect(createRelyingPartyClaims("b".repeat(64))).toEqual({ sub: "b".repeat(64) });
    expect(createLegacyRelyingPartyUser("b".repeat(64))).toEqual({ id: "b".repeat(64) });
  });

  it.todo("coordinated follow-up: RP access-token sub must become pairwise without breaking UserInfo/introspection/revocation");
  it.todo("coordinated follow-up: real service audience token must succeed in UserInfo/introspection with strict issuer/audience checks");
  it.todo("coordinated follow-up: minimize storage, BFF profiles, MCP, runtime logs and old backups");
});
