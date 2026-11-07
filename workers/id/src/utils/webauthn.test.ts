import { beforeAll, describe, expect, it } from "vite-plus/test";
import { syntheticAuthenticator } from "./__fixtures__/webauthn/synthetic";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { createWebAuthnAdapter, type WebAuthnChallengeSnapshot } from "./webauthn";
import {
  attestationNone,
  attestationNoneChallenge,
  assertionResponse,
  assertionChallenge,
  assertionOrigin,
  credential,
} from "./__fixtures__/webauthn/upstream";

const adapter = createWebAuthnAdapter({
  origin: assertionOrigin,
  rpID: "dev.dontneeda.pw",
  rpName: "Test RP",
});
const registration: WebAuthnChallengeSnapshot = {
  challenge: attestationNoneChallenge,
  ownerID: "test-owner",
  webAuthnUserID: "AQID",
  purpose: "registration",
};
const authentication: WebAuthnChallengeSnapshot = {
  ...registration,
  challenge: assertionChallenge,
  purpose: "authentication",
};
const stored = {
  registrationId: "test-generation",
  deviceType: "singleDevice" as const,
  ownerID: registration.ownerID,
  webAuthnUserID: registration.webAuthnUserID,
  credential,
};
function clientData<T extends { response: { clientDataJSON: string } }>(
  response: T,
  patch: object,
): T {
  const copy = structuredClone(response);
  const client = JSON.parse(isoBase64URL.toUTF8String(copy.response.clientDataJSON));
  copy.response.clientDataJSON = isoBase64URL.fromUTF8String(
    JSON.stringify({ ...client, ...patch }),
  );
  return copy;
}

describe("unconnected WebAuthn adapter with real SimpleWebAuthn", () => {
  it("preserves a DB-issued challenge and strict registration options", async () => {
    const result = await adapter.registrationOptions(registration, "synthetic@example.test");
    expect(result.challenge).toBe(registration.challenge);
    expect(result.user.id).toBe(registration.webAuthnUserID);
    expect(result.rp.id).toBe("dev.dontneeda.pw");
    expect(result.attestation).toBe("none");
    expect(result.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
      requireResidentKey: true,
    });
    expect(result.pubKeyCredParams.map(({ alg }) => alg)).toEqual([-7, -257]);
  });
  it("preserves an authentication challenge and restricts credentials", async () => {
    const result = await adapter.authenticationOptions(authentication, [stored]);
    expect(result.challenge).toBe(authentication.challenge);
    expect(result.userVerification).toBe("required");
    expect(result.allowCredentials?.map(({ id }) => id)).toEqual([credential.id]);
    await expect(adapter.authenticationOptions(authentication, [])).rejects.toThrow(
      "WebAuthn options unavailable",
    );
  });
  it("verifies the upstream UP+UV none-attestation fixture", async () => {
    const result = await adapter.verifyRegistration(registration, attestationNone);
    expect(result).toMatchObject({
      verified: true,
      ownerID: "test-owner",
      webAuthnUserID: "AQID",
      deviceType: "singleDevice",
      backedUp: false,
    });
    if (!result.verified) throw new Error("Expected verified fixture");
    expect(result.credential.id).toBe(attestationNone.id);
    expect(result.credential.counter).toBe(0);
    expect(isoBase64URL.fromBuffer(result.credential.publicKey)).toBe(
      "pQECAyYgASFYID5PQTZQQg6haZFQWFzqfAOyQ_ENsMH8xxQ4GRiNPsqrIlggU8IVUOV8qpgk_Jh-OTaLuZL52KdX1fTht07X4DiQPow",
    );
  });
  it.each([
    ["challenge", { challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    ["origin", { origin: "https://elsewhere.example" }],
    ["type", { type: "webauthn.get" }],
    ["cross-origin", { crossOrigin: true }],
    ["top-origin", { topOrigin: assertionOrigin }],
    ["malformed cross-origin flag", { crossOrigin: "false" }],
  ])("rejects registration %s without exposing input", async (_name, patch) => {
    expect(
      await adapter.verifyRegistration(registration, clientData(attestationNone, patch)),
    ).toEqual({ verified: false });
  });
  it("rejects the wrong RP ID", async () => {
    const other = createWebAuthnAdapter({
      origin: assertionOrigin,
      rpID: "dev.dontneeda.pw",
      rpName: "Other",
    });
    // Keep the fixture's RP hash but use another configured origin/RP pair.
    const mismatch = createWebAuthnAdapter({
      origin: "https://other.example",
      rpID: "other.example",
      rpName: "Other",
    });
    expect(
      await mismatch.verifyRegistration(
        registration,
        clientData(attestationNone, { origin: "https://other.example" }),
      ),
    ).toEqual({ verified: false });
    expect(
      await other.verifyRegistration(
        { ...registration, purpose: "authentication" },
        attestationNone,
      ),
    ).toEqual({ verified: false });
  });
  it.each(["packed", "fido-u2f", "android-key", "tpm", "apple", "android-safetynet"])(
    "rejects unsupported attestation format %s before full verification",
    async (fmt) => {
      const decoded = isoCBOR.decodeFirst<Map<string, string | Uint8Array | Map<string, never>>>(
        isoBase64URL.toBuffer(attestationNone.response.attestationObject),
      );
      decoded.set("fmt", fmt);
      const response = structuredClone(attestationNone);
      response.response.attestationObject = isoBase64URL.fromBuffer(isoCBOR.encode(decoded));
      expect(await adapter.verifyRegistration(registration, response)).toEqual({ verified: false });
    },
  );

  it.each([{ statement: "invalid" }, { statement: 0 }, { statement: [] }, { statement: null }])(
    "rejects malformed none attStmt: %j",
    async ({ statement }) => {
      const decoded = isoCBOR.decodeFirst<Map<string, Parameters<typeof isoCBOR.encode>[0]>>(
        isoBase64URL.toBuffer(attestationNone.response.attestationObject),
      );
      decoded.set("attStmt", statement);
      const response = structuredClone(attestationNone);
      response.response.attestationObject = isoBase64URL.fromBuffer(isoCBOR.encode(decoded));
      expect(await adapter.verifyRegistration(registration, response)).toEqual({ verified: false });
    },
  );

  it("rejects missing UP or UV using the real library parser", async () => {
    // A test-only bit mutation in the published none attestation. No CBOR implementation.
    // Find the exact authenticator-data RP hash prefix in the test vector.
    const original = isoBase64URL.toBuffer(attestationNone.response.attestationObject);
    const rpHash = isoBase64URL.toBuffer(assertionResponse.response.authenticatorData).slice(0, 32);
    const offset = original.findIndex((_, i) =>
      rpHash.every((byte, j) => original[i + j] === byte),
    );
    expect(offset).toBeGreaterThan(0);
    for (const flag of [1, 4]) {
      const changed = structuredClone(attestationNone);
      const bytes = original.slice();
      bytes[offset + 32] &= ~flag;
      changed.response.attestationObject = isoBase64URL.fromBuffer(bytes);
      expect(await adapter.verifyRegistration(registration, changed)).toEqual({ verified: false });
    }
  });
  it("proves upstream assertion signature is valid but strict UV policy rejects it", async () => {
    const raw = await verifyAuthenticationResponse({
      response: assertionResponse,
      expectedChallenge: assertionChallenge,
      expectedOrigin: assertionOrigin,
      expectedRPID: "dev.dontneeda.pw",
      credential,
      requireUserVerification: false,
    });
    expect(raw.verified).toBe(true);
    expect(raw.authenticationInfo.newCounter).toBe(144);
    expect(raw.authenticationInfo.userVerified).toBe(false);
    expect(await adapter.verifyAuthentication(authentication, stored, assertionResponse)).toEqual({
      verified: false,
    });
  });
  it("rejects replayed counters and tampered signatures with the real verifier", async () => {
    const input = {
      response: assertionResponse,
      expectedChallenge: assertionChallenge,
      expectedOrigin: assertionOrigin,
      expectedRPID: "dev.dontneeda.pw",
      credential,
      requireUserVerification: false,
    };
    await expect(
      verifyAuthenticationResponse({ ...input, credential: { ...credential, counter: 144 } }),
    ).rejects.toThrow();
    const response = structuredClone(assertionResponse);
    const signature = isoBase64URL.toBuffer(response.response.signature);
    signature[signature.length - 1] ^= 1;
    response.response.signature = isoBase64URL.fromBuffer(signature);
    expect((await verifyAuthenticationResponse({ ...input, response })).verified).toBe(false);
  });
  it("rejects mismatched credential ownership, IDs and user handles", async () => {
    for (const bad of [
      { ...stored, ownerID: "other" },
      { ...stored, webAuthnUserID: "BAUG" },
      { ...stored, registrationId: "" },
    ]) {
      expect(await adapter.verifyAuthentication(authentication, bad, assertionResponse)).toEqual({
        verified: false,
      });
      await expect(adapter.authenticationOptions(authentication, [bad])).rejects.toThrow(
        "WebAuthn options unavailable",
      );
    }
    expect(
      await adapter.verifyAuthentication(authentication, stored, {
        ...assertionResponse,
        id: "AQID",
      }),
    ).toEqual({ verified: false });
    expect(
      await adapter.verifyAuthentication(authentication, stored, {
        ...assertionResponse,
        response: { ...assertionResponse.response, userHandle: "BAUG" },
      }),
    ).toEqual({ verified: false });
  });
  it("rejects malformed data, invalid context and credential ID substitution", async () => {
    expect(await adapter.verifyRegistration(registration, null as never)).toEqual({
      verified: false,
    });
    expect(await adapter.verifyAuthentication(authentication, stored, null as never)).toEqual({
      verified: false,
    });
    expect(
      await adapter.verifyRegistration(registration, {
        ...attestationNone,
        id: "AQID",
        rawId: "AQID",
      }),
    ).toEqual({ verified: false });
    await expect(
      adapter.registrationOptions({ ...registration, challenge: "short" }, "test"),
    ).rejects.toThrow("WebAuthn options unavailable");
  });
  it("rejects non-exact or insecure policy and snapshots configured policy", async () => {
    for (const origin of [
      "https://dev.dontneeda.pw/",
      "http://dev.dontneeda.pw",
      "https://user@dev.dontneeda.pw",
    ]) {
      expect(() =>
        createWebAuthnAdapter({ origin, rpID: "dev.dontneeda.pw", rpName: "Test" }),
      ).toThrow();
    }
    const policy = { origin: assertionOrigin, rpID: "dev.dontneeda.pw", rpName: "Test" };
    const captured = createWebAuthnAdapter(policy);
    policy.origin = "https://other.example";
    expect((await captured.verifyRegistration(registration, attestationNone)).verified).toBe(true);
  });
});

describe("strict policy and bounded proof data", () => {
  it.each([
    ["http://localhost", "localhost"],
    ["https://localhost", "localhost"],
    ["https://127.0.0.1", "127.0.0.1"],
    ["https://[::1]", "[::1]"],
    ["https://dev.dontneeda.pw.", "dev.dontneeda.pw."],
    ["https://*.dontneeda.pw", "*.dontneeda.pw"],
    ["https://dev.dontneeda.pw", "dontneeda.pw"],
    ["https://bad_label.example", "bad_label.example"],
  ])("rejects unsafe policy %s", (origin, rpID) => {
    expect(() => createWebAuthnAdapter({ origin, rpID, rpName: "Test" })).toThrow();
  });
  it.each([-1, 0x100000000, 1.5, NaN, Infinity])(
    "rejects invalid stored uint32 counter %s",
    async (counter) => {
      const bad = { ...stored, credential: { ...credential, counter } };
      await expect(adapter.authenticationOptions(authentication, [bad])).rejects.toThrow(
        "WebAuthn options unavailable",
      );
      expect(await adapter.verifyAuthentication(authentication, bad, assertionResponse)).toEqual({
        verified: false,
      });
    },
  );
  it.each([
    ["attestationObject", 65536],
    ["clientDataJSON", 16384],
  ] as const)("rejects oversized registration %s", async (field, maximum) => {
    const response = structuredClone(attestationNone);
    response.response[field] = "A".repeat(maximum + 1);
    expect(await adapter.verifyRegistration(registration, response)).toEqual({ verified: false });
  });
  it.each([
    ["authenticatorData", 16384],
    ["signature", 2048],
    ["clientDataJSON", 16384],
  ] as const)("rejects oversized authentication %s", async (field, maximum) => {
    const response = structuredClone(assertionResponse);
    response.response[field] = "A".repeat(maximum + 1);
    expect(await adapter.verifyAuthentication(authentication, stored, response)).toEqual({
      verified: false,
    });
  });
  it("rejects excessive credential/key/context sizes and registration rawId mismatch", async () => {
    expect(
      await adapter.verifyRegistration(registration, { ...attestationNone, rawId: "AQID" }),
    ).toEqual({ verified: false });
    expect(
      await adapter.verifyRegistration(registration, {
        ...attestationNone,
        id: "A".repeat(1367),
        rawId: "A".repeat(1367),
      }),
    ).toEqual({ verified: false });
    const bad = { ...stored, credential: { ...credential, publicKey: new Uint8Array(4097) } };
    await expect(adapter.authenticationOptions(authentication, [bad])).rejects.toThrow(
      "WebAuthn options unavailable",
    );
    await expect(
      adapter.registrationOptions({ ...registration, challenge: "A".repeat(1367) }, "Test"),
    ).rejects.toThrow("WebAuthn options unavailable");
    expect(
      await adapter.verifyRegistration(registration, {
        ...attestationNone,
        response: { ...attestationNone.response, transports: Array(17).fill("internal") },
      }),
    ).toEqual({ verified: false });
  });
});

describe("real RS256 verification with an ephemeral test-only authenticator", () => {
  let fixture: Awaited<ReturnType<typeof syntheticAuthenticator>>;
  beforeAll(async () => {
    fixture = await syntheticAuthenticator();
  });
  it.each([
    [0, 0],
    [0, 1],
    [40, 41],
    [0xfffffffe, 0xffffffff],
  ])(
    "verifies UP+UV, counter %s to %s, and forwards the saved generation",
    async (previous, next) => {
      const saved = {
        ...fixture.stored,
        credential: { ...fixture.stored.credential, counter: previous },
      };
      expect(
        await adapter.verifyAuthentication(fixture.snapshot, saved, await fixture.assertion(next)),
      ).toEqual({
        verified: true,
        ownerID: fixture.stored.ownerID,
        credentialID: fixture.stored.credential.id,
        registrationId: fixture.stored.registrationId,
        newCounter: next,
        deviceType: "singleDevice",
        backedUp: false,
      });
    },
  );
  it("rejects tampered signatures through the adapter false branch", async () => {
    const response = await fixture.assertion();
    const signature = isoBase64URL.toBuffer(response.response.signature);
    signature[signature.length - 1] ^= 1;
    response.response.signature = isoBase64URL.fromBuffer(signature);
    expect(await adapter.verifyAuthentication(fixture.snapshot, fixture.stored, response)).toEqual({
      verified: false,
    });
  });
  it.each([0x01, 0x04, 0x00])(
    "rejects signed authenticator flags without both UP and UV: %s",
    async (flags) => {
      expect(
        await adapter.verifyAuthentication(
          fixture.snapshot,
          fixture.stored,
          await fixture.assertion(0, flags),
        ),
      ).toEqual({ verified: false });
    },
  );
  it("rejects non-increasing counter and owner/handle/ID mismatch on otherwise valid signed assertions", async () => {
    const response = await fixture.assertion(1);
    const previous = {
      ...fixture.stored,
      credential: { ...fixture.stored.credential, counter: 1 },
    };
    expect(await adapter.verifyAuthentication(fixture.snapshot, previous, response)).toEqual({
      verified: false,
    });
    expect(
      await adapter.verifyAuthentication(
        fixture.snapshot,
        { ...fixture.stored, ownerID: "other" },
        response,
      ),
    ).toEqual({ verified: false });
    expect(
      await adapter.verifyAuthentication(fixture.snapshot, fixture.stored, {
        ...response,
        response: { ...response.response, userHandle: "AQID" },
      }),
    ).toEqual({ verified: false });
    expect(
      await adapter.verifyAuthentication(fixture.snapshot, fixture.stored, {
        ...response,
        id: "AQID",
        rawId: "AQID",
      }),
    ).toEqual({ verified: false });
  });
  it("takes enrollment generation only from the trusted snapshot, never response extensions", async () => {
    const response = await fixture.assertion();
    const submitted = { ...response, registrationId: "attacker-supplied-generation" };
    const result = await adapter.verifyAuthentication(fixture.snapshot, fixture.stored, submitted);
    expect(result).toMatchObject({ verified: true, registrationId: "synthetic-generation" });
    // Detecting deletion/re-enrollment is the storage CAS's job, not crypto's.
    expect(
      await adapter.verifyAuthentication(
        fixture.snapshot,
        { ...fixture.stored, registrationId: "" },
        response,
      ),
    ).toEqual({ verified: false });
  });
  it.each([
    { crossOrigin: true },
    { topOrigin: assertionOrigin },
    { challenge: "wrong" },
    { origin: "https://other.example" },
  ])("rejects changed client context %j", async (patch) => {
    expect(
      await adapter.verifyAuthentication(
        fixture.snapshot,
        fixture.stored,
        clientData(await fixture.assertion(), patch),
      ),
    ).toEqual({ verified: false });
  });
  it("rejects a correctly signed change of backup eligibility but permits backup-state changes", async () => {
    const fixture = await syntheticAuthenticator();
    const be = await fixture.assertion(1, 0x0d);
    expect(await adapter.verifyAuthentication(fixture.snapshot, fixture.stored, be)).toEqual({
      verified: false,
    });
    const multi = { ...fixture.stored, deviceType: "multiDevice" as const };
    expect(
      await adapter.verifyAuthentication(fixture.snapshot, multi, await fixture.assertion(1, 0x05)),
    ).toEqual({ verified: false });
    for (const [flags, backedUp] of [
      [0x0d, false],
      [0x1d, true],
    ] as const) {
      expect(
        await adapter.verifyAuthentication(
          fixture.snapshot,
          multi,
          await fixture.assertion(1, flags),
        ),
      ).toMatchObject({ verified: true, deviceType: "multiDevice", backedUp });
    }
  });
});
