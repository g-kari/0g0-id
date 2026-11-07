/** Unconnected WebAuthn boundary. No routes, sessions, mail, or database writes.
 * Callers must load snapshots from trusted storage, verify expiry/session binding,
 * and atomically consume challenges and persist counters before issuing a session.
 * Never construct snapshots from the request body. */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
  type CredentialDeviceType,
} from "@simplewebauthn/server";
import {
  decodeAttestationObject,
  decodeClientDataJSON,
  decodeCredentialPublicKey,
  isoBase64URL,
} from "@simplewebauthn/server/helpers";

export interface WebAuthnPolicy {
  readonly origin: string;
  readonly rpID: string;
  readonly rpName: string;
}

/** Server-loaded challenge row after expiry, purpose and session checks. */
export interface WebAuthnChallengeSnapshot {
  readonly challenge: string;
  readonly ownerID: string;
  readonly webAuthnUserID: string;
  readonly purpose: "registration" | "authentication";
}

/** Server-loaded credential row, never a client-supplied key or counter. */
export interface WebAuthnCredentialSnapshot {
  readonly registrationId: string;
  /** Saved registration-time backup eligibility; BS may change but BE must not. */
  readonly deviceType: CredentialDeviceType;
  readonly ownerID: string;
  readonly webAuthnUserID: string;
  readonly credential: WebAuthnCredential;
}

export type WebAuthnFailure = { readonly verified: false };
export type WebAuthnRegistrationResult =
  | WebAuthnFailure
  | {
      readonly verified: true;
      readonly ownerID: string;
      readonly webAuthnUserID: string;
      readonly credential: WebAuthnCredential;
      readonly deviceType: CredentialDeviceType;
      readonly backedUp: boolean;
    };
export type WebAuthnAuthenticationResult =
  | WebAuthnFailure
  | {
      readonly verified: true;
      readonly ownerID: string;
      readonly credentialID: string;
      readonly registrationId: string;
      readonly newCounter: number;
      readonly deviceType: CredentialDeviceType;
      readonly backedUp: boolean;
    };

const ALGORITHMS = [-7, -257];
const FAILURE: WebAuthnFailure = Object.freeze({ verified: false });

function bytes(value: string, minimum: number, maximum: number): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((maximum * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new Error("Invalid WebAuthn context");
  const decoded = isoBase64URL.toBuffer(value);
  if (
    decoded.length < minimum ||
    decoded.length > maximum ||
    isoBase64URL.fromBuffer(decoded) !== value
  ) {
    throw new Error("Invalid WebAuthn context");
  }
  return decoded;
}

function checkContext(
  snapshot: WebAuthnChallengeSnapshot,
  purpose: WebAuthnChallengeSnapshot["purpose"],
) {
  if (!snapshot.ownerID || snapshot.purpose !== purpose)
    throw new Error("Invalid WebAuthn context");
  bytes(snapshot.challenge, 16, 1024);
  bytes(snapshot.webAuthnUserID, 1, 64);
}

// Encoded wire-field limits, checked before parsing/crypto. The eventual HTTP
// route must additionally cap total JSON body size before reading/parsing it.
function boundedProof(value: string, maximum: number) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error("Invalid WebAuthn response");
  }
}

function sameOriginOnly(clientDataJSON: string) {
  if (typeof clientDataJSON !== "string" || clientDataJSON.length > 16384)
    throw new Error("Invalid WebAuthn response");
  const client = decodeClientDataJSON(clientDataJSON);
  if (
    (client.crossOrigin !== undefined && client.crossOrigin !== false) ||
    client.topOrigin !== undefined
  ) {
    throw new Error("Invalid WebAuthn response");
  }
}

function checkCredential(snapshot: WebAuthnChallengeSnapshot, stored: WebAuthnCredentialSnapshot) {
  if (
    !stored.registrationId ||
    !["singleDevice", "multiDevice"].includes(stored.deviceType) ||
    snapshot.ownerID !== stored.ownerID ||
    snapshot.webAuthnUserID !== stored.webAuthnUserID
  ) {
    throw new Error("Invalid WebAuthn context");
  }
  bytes(stored.credential.id, 1, 1024);
  if (
    !Number.isSafeInteger(stored.credential.counter) ||
    stored.credential.counter < 0 ||
    stored.credential.counter > 0xffffffff
  ) {
    throw new Error("Invalid WebAuthn context");
  }
  if (
    !(stored.credential.publicKey instanceof Uint8Array) ||
    stored.credential.publicKey.length > 4096
  ) {
    throw new Error("Invalid WebAuthn context");
  }
  // Parsing is delegated to the library; COSE label 3 is the algorithm identifier.
  if (
    !ALGORITHMS.includes(decodeCredentialPublicKey(stored.credential.publicKey).get(3) as number)
  ) {
    throw new Error("Invalid WebAuthn context");
  }
}

export function createWebAuthnAdapter(policy: WebAuthnPolicy) {
  // Capture immutable configured values, never Host/Origin headers or a request URL.
  const { origin, rpID, rpName } = policy;
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.hostname !== rpID ||
    url.username ||
    url.password ||
    !rpName ||
    url.protocol !== "https:" ||
    rpID.endsWith(".") ||
    rpID.includes("*") ||
    !rpID.includes(".") ||
    /^[\d.]+$/.test(rpID) ||
    rpID.includes(":") ||
    rpID.length > 253 ||
    rpID.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error("Invalid WebAuthn configuration");
  }
  return {
    async registrationOptions(
      snapshot: WebAuthnChallengeSnapshot,
      userName: string,
      existing: readonly WebAuthnCredentialSnapshot[] = [],
    ) {
      try {
        checkContext(snapshot, "registration");
        for (const stored of existing) checkCredential(snapshot, stored);
        return await generateRegistrationOptions({
          rpName,
          rpID,
          userName,
          userID: bytes(snapshot.webAuthnUserID, 1, 64),
          // The DB stores the encoded wire challenge. Passing a string here would encode it twice.
          challenge: bytes(snapshot.challenge, 16, 1024),
          attestationType: "none",
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          supportedAlgorithmIDs: [...ALGORITHMS],
          excludeCredentials: existing.map(({ credential }) => ({
            id: credential.id,
            transports: credential.transports,
          })),
        });
      } catch {
        throw new Error("WebAuthn options unavailable");
      }
    },
    async authenticationOptions(
      snapshot: WebAuthnChallengeSnapshot,
      stored: readonly WebAuthnCredentialSnapshot[],
    ) {
      try {
        checkContext(snapshot, "authentication");
        // This is the email-first flow; an empty list must not silently enable discoverable login.
        if (stored.length === 0) throw new Error("Invalid WebAuthn context");
        for (const item of stored) checkCredential(snapshot, item);
        return await generateAuthenticationOptions({
          rpID,
          challenge: bytes(snapshot.challenge, 16, 1024),
          userVerification: "required",
          allowCredentials: stored.map(({ credential }) => ({
            id: credential.id,
            transports: credential.transports,
          })),
        });
      } catch {
        throw new Error("WebAuthn options unavailable");
      }
    },
    async verifyRegistration(
      snapshot: WebAuthnChallengeSnapshot,
      response: RegistrationResponseJSON,
    ): Promise<WebAuthnRegistrationResult> {
      try {
        checkContext(snapshot, "registration");
        if (response.rawId !== response.id) return FAILURE;
        bytes(response.id, 1, 1024);
        boundedProof(response.response.attestationObject, 65536);
        const transports = response.response.transports;
        if (
          transports !== undefined &&
          (!Array.isArray(transports) ||
            transports.length > 16 ||
            transports.some((transport) => typeof transport !== "string" || transport.length > 32))
        )
          return FAILURE;
        sameOriginOnly(response.response.clientDataJSON);
        // Reject certificate/metadata attestation before verification can perform
        // unsupported certificate-path or network work. This RP requests none.
        const attestation: unknown = decodeAttestationObject(
          isoBase64URL.toBuffer(response.response.attestationObject),
        );
        if (!(attestation instanceof Map)) return FAILURE;
        const format: unknown = attestation.get("fmt");
        const statement: unknown = attestation.get("attStmt");
        const authenticatorData: unknown = attestation.get("authData");
        if (
          format !== "none" ||
          !(statement instanceof Map) ||
          statement.size !== 0 ||
          !(authenticatorData instanceof Uint8Array)
        )
          return FAILURE;
        const result = await verifyRegistrationResponse({
          response,
          expectedChallenge: snapshot.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserPresence: true,
          requireUserVerification: true,
          supportedAlgorithmIDs: [...ALGORITHMS],
        });
        if (
          !result.verified ||
          result.registrationInfo.fmt !== "none" ||
          !result.registrationInfo.userVerified ||
          result.registrationInfo.credential.id !== response.id
        )
          return FAILURE;
        const info = result.registrationInfo;
        return {
          verified: true,
          ownerID: snapshot.ownerID,
          webAuthnUserID: snapshot.webAuthnUserID,
          credential: info.credential,
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
        };
      } catch {
        return FAILURE;
      }
    },
    async verifyAuthentication(
      snapshot: WebAuthnChallengeSnapshot,
      stored: WebAuthnCredentialSnapshot,
      response: AuthenticationResponseJSON,
    ): Promise<WebAuthnAuthenticationResult> {
      try {
        checkContext(snapshot, "authentication");
        checkCredential(snapshot, stored);
        if (response.id !== stored.credential.id || response.rawId !== stored.credential.id)
          return FAILURE;
        if (
          response.response.userHandle != null &&
          response.response.userHandle !== stored.webAuthnUserID
        )
          return FAILURE;
        boundedProof(response.response.authenticatorData, 16384);
        boundedProof(response.response.signature, 2048);
        sameOriginOnly(response.response.clientDataJSON);
        const result = await verifyAuthenticationResponse({
          response,
          credential: stored.credential,
          expectedChallenge: snapshot.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
          // Do not set advancedFIDOConfig: the normal path enforces UP as well as UV.
        });
        if (
          !result.verified ||
          !result.authenticationInfo.userVerified ||
          result.authenticationInfo.credentialDeviceType !== stored.deviceType
        )
          return FAILURE;
        const info = result.authenticationInfo;
        return {
          verified: true,
          ownerID: stored.ownerID,
          credentialID: info.credentialID,
          registrationId: stored.registrationId,
          newCounter: info.newCounter,
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
        };
      } catch {
        return FAILURE;
      }
    },
  };
}
