/** Test-only authenticator. Its ephemeral private CryptoKey never leaves memory.
 * Uses standard WebCrypto and the verifier library's CBOR encoder, not custom
 * cryptography/CBOR. No platform authenticator, service or user account is used.
 */
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type { WebAuthnChallengeSnapshot, WebAuthnCredentialSnapshot } from "../../webauthn";

export async function syntheticAuthenticator() {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    false,
    ["sign", "verify"],
  );
  // Only the public key is exported; the private key is non-extractable.
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const publicKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 3],
      [3, -257],
      [-1, isoBase64URL.toBuffer(jwk.n!)],
      [-2, isoBase64URL.toBuffer(jwk.e!)],
    ]),
  );
  const credentialID = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
  const webAuthnUserID = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
  const snapshot: WebAuthnChallengeSnapshot = {
    purpose: "authentication",
    ownerID: "synthetic-owner",
    webAuthnUserID,
    challenge: isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32))),
  };
  const stored: WebAuthnCredentialSnapshot = {
    registrationId: "synthetic-generation",
    deviceType: "singleDevice",
    ownerID: snapshot.ownerID,
    webAuthnUserID,
    credential: { id: credentialID, publicKey, counter: 0 },
  };
  return {
    snapshot,
    stored,
    async assertion(counter = 0, flags = 0x05): Promise<AuthenticationResponseJSON> {
      const clientDataJSON = isoBase64URL.fromUTF8String(
        JSON.stringify({
          type: "webauthn.get",
          challenge: snapshot.challenge,
          origin: "https://dev.dontneeda.pw",
          crossOrigin: false,
        }),
      );
      const authData = new Uint8Array(37);
      authData.set(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode("dev.dontneeda.pw")),
        ),
      );
      authData[32] = flags;
      new DataView(authData.buffer).setUint32(33, counter, false);
      const clientHash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", isoBase64URL.toBuffer(clientDataJSON)),
      );
      const signed = new Uint8Array(authData.length + clientHash.length);
      signed.set(authData);
      signed.set(clientHash, authData.length);
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, signed);
      return {
        id: credentialID,
        rawId: credentialID,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          authenticatorData: isoBase64URL.fromBuffer(authData),
          clientDataJSON,
          signature: isoBase64URL.fromBuffer(new Uint8Array(signature)),
          userHandle: webAuthnUserID,
        },
      };
    },
  };
}
