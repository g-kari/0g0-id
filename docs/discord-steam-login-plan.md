# Discord / Steam login

## Status and boundaries

The protocol foundation was merged in PR #385. The integration adds opt-in storage, browser-bound single-use transactions, IdP callbacks, account linking, BFF handoff and user-facing login/device/provider controls. Both new methods remain **off by default**. Existing Google/LINE/Twitch/GitHub/X credentials continue to work without applying the proposed social schema. The admin login page remains Google-only, with new provider labels available in account detail.

This code change does not create credentials or OAuth grants, connect a real account, apply production SQL, or enable either production flag. Tests use synthetic identities and intercepted provider responses. Passing those tests does not establish real Discord or Steam interoperability. Email/passkey readiness remains independent.

## Protocol and identity rules

- Discord uses authorization code + S256 PKCE with **identify only**. The expected issuer is `https://discord.com`; its metadata advertises the `iss` response and S256. Email, bot, guild, friend and offline scopes are not requested. Refresh tokens are discarded; upstream tokens are not persisted.
- Steam uses **OpenID 2.0**, not OAuth2, and needs no Steam Web API key. Identity and direct verification are restricted to Steam's documented namespace and HTTPS endpoint. No profile enrichment or ownership checks are requested.
- Stable provider subjects uniquely identify accounts. New accounts receive an opaque UUID-based, unverified placeholder address under `.invalid`, never a provider ID disguised as email. Neither method merges accounts by email or display name. Existing email, verification and role survive subsequent logins and explicit linking.
- HTTP responses have size/time limits, fixed endpoints, no redirects and no retries. Uncertain exchanges/claims require a fresh login. Error responses and logs do not include upstream bodies or credentials.

Sources: [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2), [Discord authorization-server metadata](https://discord.com/.well-known/oauth-authorization-server), [Steam browser authentication](https://partner.steamgames.com/doc/features/auth#website), [OpenID 2.0 verification](https://openid.net/specs/openid-authentication-2_0.html#verification).

## Transaction and linking controls

`DISCORD_LOGIN_ENABLED` / `STEAM_LOGIN_ENABLED` must be exactly `"true"`; Discord additionally needs its client ID/secret. A canonical configured HTTPS IdP origin and all reviewed schema components are required. Missing configuration/schema or failed discovery never exposes an actionable new-provider choice. Default-off discovery does not query optional tables.

A transaction stores only SHA-256 hashes of the random state, browser PKCE/binding cookie and exact signed state payload, plus provider, configured origin and a ten-minute database-clock expiry. It is atomically consumed before upstream verification. Signed cookies alone cannot replay it or be mixed between sessions.

Discord's shared callback requires one state/code/issuer and exact issuer. Steam's separate `/auth/steam/callback` verifies duplicate parameters, the exact server-generated return URL, signed fields, namespace, endpoint, identity and nonce freshness; only a positive direct response plus atomic database-clock nonce consumption authorizes login. Callback cancellation and failure produce no authorization code.

New-provider linking starts only from the authenticated, CSRF-protected user BFF. Its signed two-minute link intent names the provider and user. The BFF sends a four-field POST form to the IdP, never a transferable GET link. IdP requires exact `Origin: USER_ORIGIN`, exact user callback, URL-encoded body, no query fallback, duplicate or unknown fields. The JTI is hashed and claimed once atomically. This prevents an attacker from transplanting their own link URL into a victim's browser. A nonce-protected intermediate navigation page ends the BFF's exact-IdP form action before navigating to the provider. The BFF page uses origin-only referrer policy to preserve the browser's POST Origin; the IdP page suppresses referrers. Both are no-store, unframeable and use nonce-only script CSP.

Link writes atomically reject banned/deleted targets, an occupied target identity and a subject already owned by another account. When either flag is enabled, unlink writes atomically preserve at least one of the seven provider mappings, including concurrent requests. The existing default-off legacy-only unlink behavior is unchanged. Common finalization retains bans, lockout, redirect/resource policy and authorization-code rules.

## Schema candidate and rollout checklist

`docs/proposals/social-login-schema.sql` is deliberately **not** an automatic migration. It adds nullable uniquely indexed subject columns and transaction/replay tables. It neither rewrites existing account IDs nor backfills inferred account links. SQL tests apply all current migrations plus this candidate to populated local SQLite databases.

Before real enablement, obtain the required authorization separately for any new credentials, persistent account access or production enablement. Then:

1. Review the current schema, back up the target database and rehearse this additive proposal on staging. Check existing identities and uniqueness before/after. Apply SQL only under the separately approved rollout.
2. Register/configure the Discord application and exact callback `https://<configured-idp>/auth/callback` through the approved secure credential flow. Do not put secrets in repository files or task notes. Steam callback is `https://<configured-idp>/auth/steam/callback`; no API key is needed.
3. Validate configuration and schema in staging, enable one method at a time, and confirm discovery shows literal true only for ready methods. Login-only requires the flag; real account linkage is a separate deliberate authenticated action.
4. Run real browser/provider acceptance tests: login, denial, expired/replayed callback, existing-account link/unlink, last-method protection, banned accounts and BFF/device/service return paths. Verify Discord's actual `iss`, PKCE and scope behavior, and Steam's nonce/direct-verification response. Confirm the underlying D1 transaction semantics in staging.
5. Only after approved acceptance enable production. Roll back availability by setting the affected flag false; do not drop identity/replay data. Keep an existing working login method for recovery. Expired transaction, link-JTI and Steam nonce records are cleaned by the existing scheduler while either feature is enabled and schema is ready.

Remaining external acceptance steps are not grounds to describe the code as a live login service. No actual accounts or production provider settings were changed during implementation.
