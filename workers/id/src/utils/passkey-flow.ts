/**
 * Unconnected orchestration, NOT an HTTP route or session issuer. Bindings are
 * read by a trusted handler from secure cookies/server state, never copied from
 * a posted owner/key/counter. Public responses must not serialize internal proof,
 * authority or uncertain-commit receipts. Existing OAuth policy finalization,
 * lockout/rate controls and current user/service access checks remain mandatory.
 */
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import {
  findPendingEmailPasskeySignup,
  issuePendingEmailPasskeySignup,
  completeVerifiedEmailPasskeySignup,
  type EmailSignupAuthority,
  type SignupCommitOutcome,
} from "../../../../packages/shared/src/db/passkey-signup";
import {
  findPasskeyChallenge,
  issuePasskeyChallenge,
  consumePasskeyChallenge,
  passkeyRelyingParty,
} from "../../../../packages/shared/src/db/passkey-challenges";
import {
  findPasskeyCredential,
  recordVerifiedPasskeyAuthentication,
  type PasskeyCredential,
} from "../../../../packages/shared/src/db/passkey-credentials";
import { createWebAuthnAdapter, type WebAuthnCredentialSnapshot } from "./webauthn";

type EnrollmentBinding = Omit<EmailSignupAuthority, "idpOrigin">;
interface AuthenticationBinding {
  browserBinding: string;
  userId: string;
}

export function createPasskeyFlow(db: D1Database, configuredOrigin: string) {
  const { origin, rpId } = passkeyRelyingParty(configuredOrigin);
  const verifier = createWebAuthnAdapter({ origin, rpID: rpId, rpName: "0g0-id" });

  async function credentialSnapshot(
    row: PasskeyCredential,
  ): Promise<WebAuthnCredentialSnapshot | null> {
    const handle = await db
      .prepare("SELECT webauthn_user_id FROM passkey_user_handles WHERE user_id = ?")
      .bind(row.user_id)
      .first<{ webauthn_user_id: string }>();
    if (!handle) return null;
    return {
      ownerID: row.user_id,
      webAuthnUserID: handle.webauthn_user_id,
      registrationId: row.registration_id,
      deviceType: row.device_type,
      credential: {
        id: row.credential_id,
        publicKey: isoBase64URL.toBuffer(row.public_key),
        counter: row.sign_count,
      },
    };
  }

  return {
    async registrationOptions(input: EnrollmentBinding & { pendingId?: string; userName: string }) {
      try {
        if (
          typeof input.userName !== "string" ||
          !input.userName.trim() ||
          input.userName.length > 254
        )
          return null;
        const authority = { ...input, idpOrigin: origin };
        // A lost options response must resume the same pending challenge instead
        // of forcing another email or silently replacing an in-flight ceremony.
        const existing = input.pendingId
          ? { id: input.pendingId }
          : await db
              .prepare("SELECT id FROM passkey_signup_pending WHERE intent_id = ?")
              .bind(input.intentId)
              .first<{ id: string }>();
        const pending = existing
          ? await findPendingEmailPasskeySignup(db, { ...authority, pendingId: existing.id })
          : await issuePendingEmailPasskeySignup(db, authority);
        if (!pending) return null;
        const options = await verifier.registrationOptions(
          {
            challenge: pending.challenge,
            ownerID: pending.user_id,
            webAuthnUserID: pending.webauthn_user_id,
            purpose: "registration",
          },
          input.userName,
        );
        return { pendingId: pending.id, options };
      } catch {
        return null;
      }
    },

    async completeRegistration(
      input: EnrollmentBinding & {
        pendingId: string;
        name: string;
        response: RegistrationResponseJSON;
      },
    ): Promise<SignupCommitOutcome> {
      try {
        const authority = { ...input, idpOrigin: origin };
        const pending = await findPendingEmailPasskeySignup(db, authority);
        if (!pending) return { status: "not_created" };
        const result = await verifier.verifyRegistration(
          {
            challenge: pending.challenge,
            ownerID: pending.user_id,
            webAuthnUserID: pending.webauthn_user_id,
            purpose: "registration",
          },
          input.response,
        );
        if (!result.verified) return { status: "not_created" };
        return await completeVerifiedEmailPasskeySignup(db, {
          ...authority,
          challenge: pending.challenge,
          credential: {
            verified: true,
            ownerID: result.ownerID,
            webAuthnUserID: result.webAuthnUserID,
            credentialId: result.credential.id,
            publicKey: isoBase64URL.fromBuffer(result.credential.publicKey),
            counter: result.credential.counter,
            deviceType: result.deviceType,
            backedUp: result.backedUp,
            transports: result.credential.transports,
          },
        });
      } catch {
        return { status: "not_created" };
      }
    },

    /** userId is resolved from server-side state. Do not expose null vs options as an account lookup API. */
    async authenticationOptions(input: AuthenticationBinding) {
      try {
        const eligible = await db
          .prepare("SELECT id FROM users WHERE id = ? AND email_verified = 1 AND banned_at IS NULL")
          .bind(input.userId)
          .first<{ id: string }>();
        if (!eligible) return null;
        const rows = await db
          .prepare("SELECT * FROM passkey_credentials WHERE user_id = ?")
          .bind(input.userId)
          .all<PasskeyCredential>();
        const stored = await Promise.all(rows.results.map(credentialSnapshot));
        if (stored.length === 0 || stored.some((s) => s === null)) return null;
        const challenge = await issuePasskeyChallenge(db, {
          ...input,
          idpOrigin: origin,
          ceremony: "authentication",
        });
        if (!challenge) return null;
        const options = await verifier.authenticationOptions(
          {
            challenge: challenge.challenge,
            ownerID: input.userId,
            webAuthnUserID: stored[0]!.webAuthnUserID,
            purpose: "authentication",
          },
          stored as WebAuthnCredentialSnapshot[],
        );
        return { challengeId: challenge.id, options };
      } catch {
        return null;
      }
    },

    async authenticate(
      input: AuthenticationBinding & { challengeId: string; response: AuthenticationResponseJSON },
    ): Promise<{ verified: false } | { verified: true; userId: string }> {
      try {
        const binding = {
          ...input,
          id: input.challengeId,
          idpOrigin: origin,
          ceremony: "authentication" as const,
        };
        const challenge = await findPasskeyChallenge(db, binding);
        if (!challenge) return { verified: false };
        const row = await findPasskeyCredential(db, {
          credentialId: input.response.id,
          userId: input.userId,
        });
        if (!row) return { verified: false };
        const stored = await credentialSnapshot(row);
        if (!stored) return { verified: false };
        const result = await verifier.verifyAuthentication(
          {
            challenge: challenge.challenge,
            ownerID: row.user_id,
            webAuthnUserID: stored.webAuthnUserID,
            purpose: "authentication",
          },
          stored,
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
        return saved ? { verified: true, userId: row.user_id } : { verified: false };
      } catch {
        return { verified: false };
      }
    },
  };
}
