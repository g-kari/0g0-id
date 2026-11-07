/** A separate, explicitly discoverable login ceremony. No email lookup API. */
import {
  generateAuthenticationOptions,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import {
  issuePasskeyChallenge,
  findPasskeyChallenge,
  consumePasskeyChallenge,
  passkeyRelyingParty,
} from "../../../../packages/shared/src/db/passkey-challenges";
import {
  recordVerifiedPasskeyAuthentication,
  type PasskeyCredential,
} from "../../../../packages/shared/src/db/passkey-credentials";
import { createWebAuthnAdapter } from "./webauthn";

export function createDiscoverablePasskeyFlow(db: D1Database, configuredOrigin: string) {
  const { origin, rpId } = passkeyRelyingParty(configuredOrigin);
  const verifier = createWebAuthnAdapter({ origin, rpID: rpId, rpName: "0g0-id" });
  return {
    async options(browserBinding: string) {
      const challenge = await issuePasskeyChallenge(db, {
        browserBinding,
        idpOrigin: origin,
        ceremony: "authentication",
        userId: null,
      });
      if (!challenge) return null;
      const options = await generateAuthenticationOptions({
        rpID: rpId,
        challenge: isoBase64URL.toBuffer(challenge.challenge),
        userVerification: "required",
        // Deliberately no allowCredentials and no account lookup. The browser
        // selects an RP-scoped discoverable credential with explicit user action.
      });
      return { challengeId: challenge.id, options };
    },
    async authenticate(input: {
      browserBinding: string;
      challengeId: string;
      response: AuthenticationResponseJSON;
    }): Promise<{ verified: false } | { verified: true; userId: string }> {
      try {
        const binding = {
          browserBinding: input.browserBinding,
          id: input.challengeId,
          userId: null,
          ceremony: "authentication" as const,
          idpOrigin: origin,
        };
        const challenge = await findPasskeyChallenge(db, binding);
        if (
          !challenge ||
          typeof input.response.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,1366}$/.test(input.response.id)
        )
          return { verified: false };
        // The posted credential ID is only a lookup hint. Its claimed owner is
        // not authenticated until signature + exact userHandle verification.
        const row = await db
          .prepare(`SELECT c.*, h.webauthn_user_id FROM passkey_credentials c
            JOIN passkey_user_handles h ON h.user_id = c.user_id
            JOIN users u ON u.id = c.user_id
            WHERE c.credential_id = ? AND u.email_verified = 1 AND u.banned_at IS NULL`)
          .bind(input.response.id)
          .first<PasskeyCredential & { webauthn_user_id: string }>();
        if (!row || input.response.response.userHandle !== row.webauthn_user_id)
          return { verified: false };
        const result = await verifier.verifyAuthentication(
          {
            challenge: challenge.challenge,
            purpose: "authentication",
            ownerID: row.user_id,
            webAuthnUserID: row.webauthn_user_id,
          },
          {
            ownerID: row.user_id,
            webAuthnUserID: row.webauthn_user_id,
            registrationId: row.registration_id,
            deviceType: row.device_type,
            credential: {
              id: row.credential_id,
              publicKey: isoBase64URL.toBuffer(row.public_key),
              counter: row.sign_count,
            },
          },
          input.response,
        );
        if (!result.verified || !(await consumePasskeyChallenge(db, binding)))
          return { verified: false };
        const saved = await recordVerifiedPasskeyAuthentication(db, {
          credentialId: result.credentialID,
          registrationId: result.registrationId,
          userId: result.ownerID,
          previousCounter: row.sign_count,
          newCounter: result.newCounter,
        });
        return saved ? { verified: true, userId: result.ownerID } : { verified: false };
      } catch {
        // Storage uncertainty must not issue a code or replay the assertion.
        return { verified: false };
      }
    },
  };
}
