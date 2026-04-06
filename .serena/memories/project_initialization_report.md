# 0g0-id Project Initialization Report (2026-04-06)

## Project Onboarding Status
✅ **ONBOARDING COMPLETE** — Project memories already exist:
- `project_overview`
- `code_conventions`
- `suggested_commands`

## Project Structure

### Core Architecture
**0g0-id** is a monorepo implementing an OAuth2/OIDC-compliant Identity Provider (IdP) using:
- **Cloudflare Workers** (serverless runtime)
- **Hono** (web framework)
- **TypeScript** (strict mode)
- **D1** (SQLite-compatible database)
- **ES256** (JWT signing with JOSE + WebCrypto)

### Workspace Layout
```
0g0-id/
├── workers/
│   ├── id/        - IdP Core API (:8787) - authentication, JWT, DB, tokens
│   ├── user/      - User BFF (:8788) - login UI, profile, connections
│   ├── admin/     - Admin BFF (:8789) - service management, user management
│   └── mcp/       - MCP server implementation for tooling
├── packages/
│   └── shared/    - Common types, libraries, DB operations (no build step, direct source)
├── migrations/    - D1 schema (21 migration files)
├── docs/          - Setup and integration guides
└── .claude/       - Claude Code configuration
```

### NPM Workspace Scripts
- `npm run dev:id|user|admin` — Start development servers (:8787, :8788, :8789)
- `npm run deploy:id|user|admin` — Deploy to Cloudflare Workers
- `npm run migrate:id` — Apply migrations to production DB
- `npm run typecheck` — Full workspace type checking
- `npm run test` — Full workspace test suite (vitest)

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (Wrangler) |
| Framework | Hono |
| Language | TypeScript (strict) |
| Database | Cloudflare D1 (SQLite) |
| Signing | jose (ES256 + WebCrypto) |
| Validation | zod |
| Testing | vitest |
| Env Secrets | .dev.vars (local) or Cloudflare Secrets (production) |

## Database Schema
- **21 migration files** (chronological, starting from `0001_initial.sql`)
- Key tables: users, services, service_redirect_uris, auth_codes, refresh_tokens, login_events, admin_audit_logs, device_codes, revoked_access_tokens, mcp_sessions
- Security: CHECK constraints, indexes, cascade deletes, timestamp tracking (ISO format)

## Core Entities (packages/shared/src/types.ts)

| Interface | Purpose |
|-----------|---------|
| `User` | User profile (id, email, name, oauth_providers) |
| `Service` | OAuth application registration |
| `ServiceRedirectUri` | Whitelisted redirect URIs |
| `AuthCode` | OAuth authorization codes (PKCE + state) |
| `RefreshToken` | Long-lived tokens (family ID, reuse detection) |
| `LoginEvent` | Login audit trail (provider, country, IP) |
| `AdminAuditLog` | Admin action logging |
| `TokenPayload` | JWT claims (iss, sub, email, role, scopes) |
| `IdpEnv` | IdP worker environment (DB, Google creds, JWT keys) |
| `BffEnv` | BFF worker environment (Service Bindings to IdP) |

## Code Conventions

### Response Format
- **Success**: `{ data: ... }` or `{ data: ..., meta: { total, limit, offset } }`
- **Error**: `{ error: { code: string, message: string } }`

### Database Functions (packages/shared/src/db/)
- One function per file (e.g., `login-events.ts`, `users.ts`)
- D1Database as first argument
- Timestamps in ISO format (`.toISOString()`)
- Interfaces defined within DB files

### Hono Routes (workers/*/src/routes/)
- One Hono app per route file
- Aggregated in index.ts with `app.route(...)`
- Middleware: authMiddleware (JWT verification), adminMiddleware (admin checks), rate limiting
- Rate limiters: authRateLimitMiddleware, tokenApiRateLimitMiddleware, externalApiRateLimitMiddleware

### BFF Authentication
- Service Bindings for inter-worker calls (network-free)
- Session management via Cookies (`__Host-` prefix, HttpOnly, Secure, SameSite=Lax)
- One-time authorization code exchange

## Security & Authorization

| Feature | Implementation |
|---------|------------------|
| JWT Signing | ES256 with JWKS (`/.well-known/jwks.json`) |
| OAuth Providers | Google (required), LINE, Twitch, GitHub, X (optional) |
| PKCE | State + S256 (required for authorization_code flow) |
| Refresh Token Security | Rotation + reuse detection (family ID) |
| Admin Authorization | Role-based access + DB audit logging |
| Ban/Disable Checks | adminMiddleware checks DB for BAN status |
| Rate Limiting | IP + client_id dual protection, device code per-user limits |
| CSRF | Origin header validation |
| Device Code Flow | RFC 8628, user_code brute-force protection (10/min per user) |

## Development Rules & Best Practices

### Mandatory
- **Serena MCP is required** for code operations (find_symbol, replace_symbol_body, etc.)
- **No shell commands** (grep, sed, cat) when Serena tools available
- **Migration rule**: Apply new migrations to production DB BEFORE push
  - `npm run migrate:id` applies `--remote` to ensure safety
  - Never skip this step — new columns cause `D1_ERROR: no such column` in production
- **Existing libraries required**: Use jose, zod, date-fns, etc. (no wheel reinvention)
- **Japanese commit messages**: "機能追加: 〇〇", "バグ修正: 〇〇"

### Optional Auth Providers
- Configuration in `/auth/login`: Google (mandatory), LINE, Twitch, GitHub, X
- Each provider has separate OAuth credentials

## Todo Items Status
- ✅ **ALL CRITICAL ITEMS RESOLVED** (as of 2026-04-05)
- Recent: JWT revocation, Device Code Grant RFC 8628, OIDC token flow, redirect URI normalization
- Current focus: Code review items, error handling, logging consistency

## Potential Issues & Observations

### ✅ Resolved Recently (2026-04-05)
1. MCP session in-memory → D1 persistence
2. Service Binding protection for /auth/exchange, /auth/refresh, /auth/logout
3. Device code grant user_code brute-force protection
4. Authorization code OIDC compliance (ID token issuance)
5. Redirect URI normalization and validation consistency
6. JWT access token revocation (JTI blocklist)
7. Admin route BAN checks
8. All 1286+ tests passing

### No Immediate Issues Detected
- Code conventions well-documented
- Comprehensive test coverage (vitest)
- Security hardening complete
- Migration discipline enforced
- Serena integration established

## Key Files to Monitor

| File | Purpose |
|------|---------|
| `workers/id/src/index.ts` | IdP worker entry point |
| `workers/user/src/index.ts` | User BFF entry point |
| `workers/admin/src/index.ts` | Admin BFF entry point |
| `packages/shared/src/db/*.ts` | Database operations (21 DB modules) |
| `packages/shared/src/lib/jwt.ts` | JWT signing/verification |
| `migrations/*.sql` | Database schema (21 migrations) |
| `CLAUDE.md` | Development & deployment rules |
| `README.md` | Project overview & setup |
