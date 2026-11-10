# Discord / Steam login implementation status

## Scope of this change

The standalone protocol adapters and synthetic tests are implemented. They are intentionally not exported from the shared package entry point or connected to any route, provider registry, database, discovery response or UI. Existing login behavior is unchanged. This is not a usable Discord or Steam login release.

No application credentials, OAuth grants, Steam keys, account links, production settings or migration operations are created by this change. Tests replace all provider HTTP calls with synthetic responses and do not authenticate any real account.

## Protocol choices

Discord uses an authorization code flow with S256 PKCE. Its current authorization-server metadata advertises S256. The requested scope is only `identify`; login does not require email, bot installation, guild membership, friends or a persistent refresh-token store. The adapter returns the stable Discord ID and display fields, ignores email and refresh tokens, and never merges identities by display name or email.

Sources: [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2), [authorization-server metadata](https://discord.com/.well-known/oauth-authorization-server).

Steam's web login uses OpenID 2.0 rather than OAuth2. The login proof supplies a SteamID and does not require a Web API key. Profile enrichment and game ownership are separate features and are not part of this request. The adapter restricts both identities and verification to Steam's known namespace and fixed HTTPS verification endpoint. It accepts the HTTP identity spelling documented by Valve, without fetching that URL, as well as the HTTPS spelling.

Sources: [Steam browser authentication](https://partner.steamgames.com/doc/features/auth#website), [OpenID 2.0 verification](https://openid.net/specs/openid-authentication-2_0.html#verification).

## Implemented safeguards

- Both adapters use bounded responses, a timeout, no redirects and no automatic HTTP retries. One-use codes and uncertain assertion verification are not replayed automatically. Exceptions have fixed messages and do not contain upstream bodies, identifiers or credentials.
- Discord uses only its pinned token/user endpoints, rejects malformed bearer responses and IDs, and constructs avatar URLs only from validated components.
- Steam checks the complete original callback URL for duplicate parameters, the exact expected return URL/state, a fixed provider endpoint, identical claimed/local identities, all required signed fields, and a fresh nonce. An assertion is accepted only after a positive direct verification response and atomic nonce consumption.
- Steam requires an explicit nonce-consumption callback. Its input is a SHA-256 hash, with an expiry covering the full accepted nonce lifetime. Storage must atomically reject expired nonces using its current time as well as duplicates. The adapter also rechecks freshness after both asynchronous verification and consumption. A failed, expired or repeated consumption fails closed. The repository does not yet supply production storage for this callback. A non-atomic KV read/write pair is not sufficient.

## Required integration work

1. Add a reviewed provider-identity storage design and migration candidate, with uniqueness, explicit linking, concurrent-link protection, deletion/export handling and privacy checks. Preserve account IDs and existing provider mappings. A provider ID is not an email identity.
2. Introduce separate default-off flags for the new providers and align IdP, BFF and UI discovery with actual readiness. Discord requires approved client configuration. Steam requires the new storage and route even though it has no OAuth secret.
3. Connect Discord to the existing authorization transaction, enforcing browser-bound state, PKCE and expected issuer (`https://discord.com`) at callback time. The exchange adapter alone does not validate callback state or issuer.
4. Give Steam a separate callback, not the OAuth `code` branch. Generate its expected return URL only from a verified, expiring, browser-bound server transaction. Revalidate service redirect/resource policy and explicitly handle cancellation. Never derive the expected return URL from the incoming assertion or untrusted Host headers.
5. Provide atomic nonce storage before using Steam verification. Test duplicate and concurrent callbacks with actual SQLite/D1, including uncertain commit outcomes. Keep account linking bound to the authenticated target user and require fresh authorization.
6. Reuse the existing final login path for bans, allowed users, authorization codes, scopes, resources and audit logging. Wire login/link/unlink UI, disable unsupported providers, and verify final-provider protection.
7. Run all repository checks, security review, local D1 tests and sandboxed browser regression on the integrated final commit. Provider-mocked tests do not establish real-provider interoperability. Real-account sign-in, credential configuration and production enablement require a separately authorized test/setup step.

The existing email/passkey work and its remaining browser/deployment prerequisites are independent of this provider addition.
