# Default-off email ownership and passkey signup HTTP

This proposal adds inert HTTP/UI wiring to the existing email-intent and passkey primitives. It is not a production activation, a migration, a mail API enablement, or authorization to incur new charges. OAuthProvider/ALL_PROVIDERS are unchanged. Existing OAuth emails are never automatically linked, and email proof does not provide login or recovery.

## Mandatory independent gates

The IdP requires literal `EMAIL_PASSKEY_SIGNUP_ENABLED="true"`, `VERIFICATION_EMAIL_ENABLED="true"`, and `PASSKEY_LOGIN_ENABLED="true"`, plus all of the following. Missing or malformed configuration fails closed before allocation/delivery.

- Existing `VERIFICATION_EMAIL` send binding and exactly `VERIFICATION_EMAIL_FROM="noreply@id.0g0.xyz"`.
- Existing `COOKIE_SECRET` with at least 32 characters, canonical HTTPS `IDP_ORIGIN`, and DB binding.
- Dedicated `RATE_LIMITER_EMAIL_SIGNUP` IP limiter, `RATE_LIMITER_EMAIL_SIGNUP_GLOBAL` aggregate limiter, and the native authentication `RATE_LIMITER_AUTH`. Their deployed thresholds must be approved and verified separately; this change supplies no production threshold or binding.
- `EMAIL_SIGNUP_DAILY_LIMIT` as an explicit positive safe integer, bounded so 31 times it is safe. There is no default production value.
- The reviewed proposal schema must exist before enabling the handlers. No migration or production schema mutation is included. A proposed created_at index supports the daily count; it does not create another table.

The user BFF has its own literal signup flag for its hidden-by-default links and /auth/signup entry. It cannot override the authoritative IdP gate. Sender/domain/API eligibility, account-wide mail quota, pricing, permitted budget, other account usage and any further activation terms remain unverified. Existing Workers Paid status alone does not establish these.

## Budget and single-attempt delivery

The same atomic INSERT SELECT that allocates an email intent checks the count of intents created in `[UTC day start, UTC next day)`. It serializes competing allocations across different email addresses and browsers. Rejected, uncertain or accepted delivery does not refund allocation. Cleanup retains intents until at least one day after expiry, so it cannot remove a current UTC day's evidence. Suppressed and invalid requests create no intent. Internal legacy callers may omit the helper limit, but the public route always supplies the validated mandatory value.

New allocations in any UTC calendar month are bounded by 31 times the daily cap. This is not a billing-month, currency or strict monthly-delivery guarantee: a short-lived delivery may cross a UTC day/month boundary, and other services may consume account quota. An actual billing safeguard must be verified independently before activation. The aggregate limiter additionally bounds allocation attempts; IP limits alone are insufficient.

Before the email address is submitted, a server-minted UUIDv4 is reserved in encrypted short-lived browser state for every flow, including flows later suppressed because an account exists. The public POST cannot provide that UUID. After verifying state expiry, the helper reuses the reserved UUID. A duplicate or lost-response retry cannot replace its token hash or create another outbox item. A freshly generated unused candidate token is discarded if the allocation loses. There is no resend endpoint.

The token is passed only through the in-memory delivery closure and the intended email. It is not returned in JSON, put in a cookie, or logged. Delivery runs through execution waitUntil rather than adding provider latency to the response. Eligible, existing, invalid, suppressed, budget-exhausted and uncertain allocation requests share the same 202 body and cookie behavior. This is not a constant-time guarantee for database execution. Outbox claims are single attempt; unknown provider or ledger results never trigger automatic resend. A lost successful insert response can intentionally leave an unsent reserved intent rather than risk duplicate delivery.

## Browser and proof boundaries

- Signup state, browser binding and enrollment authority use separate AEAD purposes with the existing COOKIE_SECRET-derived keys. All cookies are Secure, HttpOnly, SameSite=Lax, Path=/ and `__Host-` prefixed. The original origin, browser secret, transaction, continuation and expiry remain bound. Signup/authority lifetime is at most ten minutes even if the DB email intent lasts longer. The UI states this limit and the email displays the shorter effective expiry; delivery delay does not extend it.
- Both stream length and declared length are bounded to 32 KiB. POST requires exact Origin, same-origin Sec-Fetch-Site when supplied, supported uncompressed content type, exact expected fields and CSRF. Unknown client intent IDs, authority fields and duplicate form fields are rejected.
- The email link contains only a fragment token. The verification page synchronously removes it from history before DOM reads or network activity, including when the feature is disabled or state has expired. No token is persisted in storage. GET/HEAD neither consumes proof nor authenticates; the user must explicitly confirm a same-origin POST in the original browser/transaction.
- Only the winning consume produces enrollment authority. That authority appears only inside a different-purpose encrypted HttpOnly cookie, never UI/JSON or a plaintext signed cookie. If the response body is lost but the cookie arrived, the flow resumes with its current authority. If the winning authority cookie is lost, the consumed email token cannot mint it again.
- Registration options resume the same pending row after cancellation or response loss. Display name is nonempty, at most 100 JavaScript UTF-16 code units, and excludes C0/C1 controls. Resident credential and user verification are required. The UI has no automatic prompt or retry, suppresses duplicate actions, aborts stale work on navigation, and reloads BFCache restores.
- Caller service/redirect/resource generation are rechecked before consequential steps. Current-account collision is also checked atomically at registration: an existing OAuth account with that email is not linked.

## Registration is not login

A valid attestation-none registration, a created result, or an uncertain commit receipt never issues an authorization code. It only starts a new native-login context with a hash of the newly created credential ID and its registration generation. The browser must explicitly obtain a fresh WebAuthn get challenge and supply a new valid UP/UV signature from that credential generation. The native verifier rechecks credential ownership, userHandle, active user, verified email, ban/lockout state and counter/registration CAS. The normal finalizer preserves state, nonce, PKCE S256, service/redirect validation and the resource generation captured by the continuation.

If registration's HTTP/DB response is uncertain, do not automatically register again or send another email. The UI offers a fresh signed login. That fallback proves a currently valid passkey through the same normal path; it is not email-only recovery. Registration receipts and authority remain server-only and are not accepted as code proof. Normal token exchange/refresh policies are unchanged.

## Cleanup and rollout

The existing scheduled handler invokes email cleanup only for the literal signup flag and only after both proposal tables exist. Disabled rollout performs no proposed-table read/write; partial schema skips cleanup. Cleanup marks stale claimed deliveries uncertain, expires queued deliveries without retry, and retains daily-budget evidence for more than a UTC day. Deployment must verify the complete schema, scheduled execution and retention together before activation. No unconditional production reference to an absent table is introduced.

Remaining launch work includes real-browser/platform WebAuthn verification, email domain/binding/API eligibility and approved budget setup, deployed rate-limit semantics, schema rollout against a populated database, last-factor removal/recovery design, abuse monitoring, and exact-head formal CI. No production switch, mail, account credential, persistent access, contract or DNS change is performed by this draft.

## Validation scope

The isolated Node/SQLite suite uses real SimpleWebAuthn registration/authentication verification and real SQL transactions, with synthetic in-memory authenticators and mocked send bindings only. It tests replay/concurrency, lost insert/response/ledger outcomes, proof races, current policy, separate cookie purposes, receipt-to-fresh-signature boundaries, budget retention, cleanup gates and BFF continuation. UI tests execute emitted JavaScript against VM test doubles, not a real browser; they cannot prove actual CSP enforcement, BFCache behavior, platform prompts or cookie delivery.

Two separate limited HTTP smokes ran in actual local workerd/D1. The earlier native-login smoke passed eight groups, including HKDF/AES-GCM cookies, real RS256 UP/UV proof, standard code and replay rejection. The later signup smoke passed thirteen groups: browser cookies; one mock send and identical202 replay; scanner GET non-consumption; different-browser rejection; explicit proof POST into encrypted authority; same-pending options resume; actual attestation-none registration and atomic D1 user creation with zero codes; then a fresh RS256 get signature yielding exactly one standard code; registration/proof replay rejection; intact foreign keys and zero detected outbound/non-loopback attempts.

The signup smoke used Node24.19.0, Miniflare5.20261006.1-alpha, workerd1.20261006.1 and esbuild0.28.2 with compatibilityDate2025-04-01. Send and rate-limit bindings were in-memory synthetic stubs. Existing migrations were first applied to empty node:sqlite and the resulting schema/seeds plus proposal tables were transcribed into local D1. This does not validate original migration execution in D1, populated-database rollout, actual Cloudflare mail/rate limits, or a browser. Outbound checks were programmatic guards, not an OS firewall. Real browser behavior and production activation remain unverified.
