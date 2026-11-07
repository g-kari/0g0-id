/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { bodyLimitMiddleware } from "@0g0-id/shared";
import nativeRoutes, { type NativePasskeyEnv } from "./native-passkey";
import { syntheticAuthenticator } from "../../utils/__fixtures__/webauthn/synthetic";
import { storeVerifiedPasskey } from "../../../../../packages/shared/src/db/passkey-credentials";

const origin = "https://dev.dontneeda.pw";
const bff = "https://user.dontneeda.pw/auth/callback";
const schema = readFileSync(
  fileURLToPath(new NodeURL("../../../../../docs/proposals/passkey-schema.sql", import.meta.url)),
  "utf8",
);
const baseSchema = `
PRAGMA foreign_keys=ON;
CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,email_verified INTEGER NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',banned_at TEXT);
CREATE TABLE account_lockouts(user_id TEXT PRIMARY KEY,failed_attempts INTEGER DEFAULT 0,locked_until TEXT,last_failed_at TEXT,updated_at TEXT);
CREATE TABLE services(id TEXT PRIMARY KEY,client_id TEXT NOT NULL UNIQUE);
CREATE TABLE service_redirect_uris(id TEXT PRIMARY KEY,service_id TEXT NOT NULL,uri TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE resource_servers(id TEXT PRIMARY KEY,uri TEXT NOT NULL UNIQUE,allowed_subjects TEXT NOT NULL);
CREATE TABLE auth_codes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,service_id TEXT,code_hash TEXT NOT NULL,redirect_to TEXT NOT NULL,expires_at TEXT NOT NULL,nonce TEXT,code_challenge TEXT,code_challenge_method TEXT,scope TEXT,provider TEXT,resource TEXT,resource_server_id TEXT);
CREATE TABLE login_events(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT,ip_address TEXT,user_agent TEXT,country TEXT,success INTEGER);
`;

describe("default-off native passkey HTTP (real verifier + SQLite)", () => {
  let sqlite: DatabaseSync;
  let env: NativePasskeyEnv;
  let app: Hono;
  let cookies: Map<string, string>;
  let csrf: string;
  let beforeSql: ((sql: string) => void) | undefined;
  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(baseSchema + schema);
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: SQLInputValue[]) {
            return {
              async first() {
                beforeSql?.(sql);
                return sqlite.prepare(sql).get(...values) ?? null;
              },
              async all() {
                beforeSql?.(sql);
                return { results: sqlite.prepare(sql).all(...values) };
              },
              async run() {
                beforeSql?.(sql);
                return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    env = {
      DB: db,
      IDP_ORIGIN: origin,
      USER_ORIGIN: "https://user.dontneeda.pw",
      ADMIN_ORIGIN: "https://admin.dontneeda.pw",
      COOKIE_SECRET: "test-only-secret-".repeat(3),
      PASSKEY_LOGIN_ENABLED: "true",
      RATE_LIMITER_AUTH: { limit: vi.fn(async () => ({ success: true })) },
    } as unknown as NativePasskeyEnv;
    app = new Hono();
    app.use("*", bodyLimitMiddleware());
    app.route("/auth/passkey", nativeRoutes);
    cookies = new Map();
    beforeSql = undefined;
  });
  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });
  function jar() {
    return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async function request(path: string, init: RequestInit = {}, remember = true) {
    const headers = new Headers(init.headers);
    if (!headers.has("Cookie")) headers.set("Cookie", jar());
    const response = await app.request(
      `${origin}${path}`,
      {
        ...init,
        headers,
      },
      env,
    );
    if (remember)
      for (const header of (
        response.headers as unknown as { getSetCookie(): string[] }
      ).getSetCookie()) {
        const [pair] = header.split(";");
        const at = pair.indexOf("=");
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
    return response;
  }
  async function start(extra = "") {
    const startResponse = await request(
      `/auth/passkey/start?redirect_to=${encodeURIComponent(bff)}&state=bff-state${extra}`,
    );
    expect(startResponse.status).toBe(303);
    const page = await request("/auth/passkey");
    expect(page.status).toBe(200);
    csrf = (await page.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)![1];
    return startResponse;
  }
  async function options() {
    const response = await request("/auth/passkey/options", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ csrf, confirm: true }),
    });
    expect(response.status).toBe(200);
    return response.json<{
      options: { challenge: string; rpId: string; allowCredentials?: unknown[] };
    }>();
  }
  async function ceremony() {
    const fixture = await syntheticAuthenticator();
    sqlite
      .prepare("INSERT INTO users(id,email,email_verified,name) VALUES(?,?,1,'Synthetic')")
      .run(fixture.snapshot.ownerID, "test@example.test");
    sqlite
      .prepare("INSERT INTO passkey_user_handles(user_id,webauthn_user_id) VALUES(?,?)")
      .run(fixture.snapshot.ownerID, fixture.stored.webAuthnUserID);
    await storeVerifiedPasskey(env.DB, {
      credentialId: fixture.stored.credential.id,
      userId: fixture.snapshot.ownerID,
      publicKey: isoBase64URL.fromBuffer(fixture.stored.credential.publicKey),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    });
    await start();
    const data = await options();
    Object.assign(fixture.snapshot, { challenge: data.options.challenge });
    return { fixture, response: await fixture.assertion(1) };
  }
  async function finish(response: unknown, cookie = jar()) {
    return request("/auth/passkey/verify", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf, credential: JSON.stringify(response) }).toString(),
    });
  }
  function codeCount() {
    return sqlite.prepare("SELECT count(*) n FROM auth_codes").get()!.n;
  }

  it.each([undefined, "false", "1", "TRUE", true])(
    "is off unless the flag is the literal string true (%s)",
    async (value) => {
      Object.assign(env, { PASSKEY_LOGIN_ENABLED: value });
      expect((await request("/auth/passkey/start")).status).toBe(404);
      expect(env.RATE_LIMITER_AUTH!.limit).not.toHaveBeenCalled();
      expect(cookies.size).toBe(0);
    },
  );
  it("fails closed without a limiter and without a usable cookie secret", async () => {
    env.RATE_LIMITER_AUTH = undefined;
    expect((await request("/auth/passkey/start")).status).toBe(503);
    env.RATE_LIMITER_AUTH = { limit: async () => ({ success: true }) };
    env.COOKIE_SECRET = "short";
    expect((await request("/auth/passkey/start")).status).toBe(503);
  });
  it("does not continue when the limiter rejects or throws", async () => {
    env.RATE_LIMITER_AUTH = { limit: async () => ({ success: false }) };
    expect((await request("/auth/passkey/start")).status).toBe(429);
    env.RATE_LIMITER_AUTH = {
      limit: async () => {
        throw new Error("private provider detail");
      },
    };
    const failed = await request("/auth/passkey/start");
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private provider");
  });
  it("scanner/page GETs never create challenges or consume proof", async () => {
    const res = await start();
    for (const cookie of (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()) {
      expect(cookie).toContain("__Host-");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Path=/");
      expect(cookie).not.toContain("Domain=");
      expect(cookie).not.toContain("bff-state");
    }
    const page = await request("/auth/passkey");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await page.text()).not.toContain("https://cdn");
    expect(sqlite.prepare("SELECT count(*) n FROM passkey_challenges").get()!.n).toBe(0);
    expect(codeCount()).toBe(0);
    expect((await request("/auth/passkey/verify")).status).toBe(404);
  });
  it.each([
    undefined,
    "null",
    "https://user.dontneeda.pw",
    `${origin}/`,
    `${origin}/path`,
    "https://evil.test",
  ])("requires the exact IdP Origin (%s)", async (value) => {
    await start();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (value) headers.Origin = value;
    expect(
      (
        await request("/auth/passkey/options", {
          method: "POST",
          headers,
          body: JSON.stringify({ csrf, confirm: true }),
        })
      ).status,
    ).toBe(403);
  });
  it("requires explicit confirmation, CSRF and no client-supplied owner", async () => {
    await start();
    for (const body of [
      { csrf },
      { csrf, confirm: false },
      { csrf: "x".repeat(43), confirm: true },
      { csrf, confirm: true, userId: "other" },
    ]) {
      expect(
        (
          await request("/auth/passkey/options", {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(403);
    }
    expect(sqlite.prepare("SELECT count(*) n FROM passkey_challenges").get()!.n).toBe(0);
  });
  it("caps body bytes even with a false content-length", async () => {
    await start();
    const res = await request("/auth/passkey/options", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "Content-Length": "1" },
      body: "x".repeat(32769),
    });
    expect(res.status).toBe(413);
    expect(codeCount()).toBe(0);
  });
  it("returns account-independent options without any credentials or user identifier", async () => {
    await start();
    const data = await options();
    expect(data.options.rpId).toBe("dev.dontneeda.pw");
    expect(data.options.allowCredentials ?? []).toEqual([]);
    expect(Object.keys(data)).toEqual(["options"]);
    expect(JSON.stringify(data)).not.toMatch(
      /owner|userId|email|binding|authority|receipt|challengeId/,
    );
  });
  it("completes an actual signature to one normal code and preserves BFF state", async () => {
    const { response } = await ceremony();
    const originalCookie = jar();
    const success = await finish(response);
    expect(success.status).toBe(302);
    const target = new URL(success.headers.get("Location")!);
    expect(target.origin + target.pathname).toBe(bff);
    expect(target.searchParams.get("state")).toBe("bff-state");
    expect(target.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeCount()).toBe(1);
    expect(sqlite.prepare("SELECT provider,service_id FROM auth_codes").get()).toEqual({
      provider: "passkey",
      service_id: null,
    });
    expect((await finish(response, originalCookie)).status).toBe(400);
    expect(codeCount()).toBe(1);
  });
  it.each([null, "wrong-user-handle"])(
    "requires an exact non-null discoverable userHandle (%s)",
    async (handle) => {
      const { response } = await ceremony();
      response.response.userHandle = handle as unknown as string;
      expect((await finish(response)).status).toBe(400);
      expect(codeCount()).toBe(0);
    },
  );
  it.each(["ban", "verification", "lockout"])(
    "rechecks the current account state (%s)",
    async (kind) => {
      const { response } = await ceremony();
      if (kind === "ban") sqlite.exec("UPDATE users SET banned_at='2026-11-08T00:00:00Z'");
      if (kind === "verification") sqlite.exec("UPDATE users SET email_verified=0");
      if (kind === "lockout")
        sqlite.exec(
          "INSERT INTO account_lockouts(user_id,locked_until) SELECT id,'2999-01-01T00:00:00Z' FROM users",
        );
      expect((await finish(response)).status).toBe(400);
      expect(codeCount()).toBe(0);
    },
  );
  it("rejects a credential generation changed between verification and CAS", async () => {
    const { response } = await ceremony();
    beforeSql = (sql) => {
      if (sql.startsWith("UPDATE passkey_credentials SET")) {
        sqlite.exec("UPDATE passkey_credentials SET registration_id='reinserted-generation'");
        beforeSql = undefined;
      }
    };
    expect((await finish(response)).status).toBe(400);
    expect(codeCount()).toBe(0);
  });
  it("rechecks account eligibility after the counter update", async () => {
    const { response } = await ceremony();
    beforeSql = (sql) => {
      if (sql === "SELECT * FROM users WHERE id = ?") {
        sqlite.exec("UPDATE users SET email_verified=0");
        beforeSql = undefined;
      }
    };
    expect((await finish(response)).status).toBe(400);
    expect(codeCount()).toBe(0);
  });
  it("rejects replacement cookies from another browser and expired envelopes", async () => {
    await start();
    const oldFlow = cookies.get("__Host-idp-native-login")!;
    await start();
    cookies.set("__Host-idp-native-login", oldFlow);
    expect((await request("/auth/passkey")).status).toBe(400);
    await start();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 601000);
    expect((await request("/auth/passkey")).status).toBe(400);
  });
  it("rejects swapped authorization transactions in the same browser", async () => {
    const { response } = await ceremony();
    await start();
    await options();
    expect((await finish(response)).status).toBe(400);
    expect(codeCount()).toBe(0);
  });
  it.each([
    "&provider=google",
    "&link_token=abc",
    "&state=duplicate",
    "&resource=https://api.test",
    "&client_id=missing",
  ])("rejects untrusted or unsupported start params (%s)", async (extra) => {
    expect(
      (
        await request(
          `/auth/passkey/start?redirect_to=${encodeURIComponent(bff)}&state=bff-state${extra}`,
        )
      ).status,
    ).toBe(400);
  });
  it("requires a registered BFF callback, not just a sibling origin", async () => {
    for (const target of [
      "https://other.dontneeda.pw/auth/callback",
      "https://user.dontneeda.pw/elsewhere",
      `${bff}?next=https://evil.test`,
      "https://evil.test/auth/callback",
    ]) {
      expect(
        (await request(`/auth/passkey/start?redirect_to=${encodeURIComponent(target)}&state=x`))
          .status,
      ).toBe(400);
    }
  });
  async function serviceCeremony() {
    const { fixture } = await ceremony();
    sqlite.exec(
      "INSERT INTO services VALUES('service-1','client-1'); INSERT INTO service_redirect_uris(id,service_id,uri) VALUES('redirect-1','service-1','https://external.example.test/callback'); INSERT INTO resource_servers VALUES('resource-1','https://api.example.test/','[]');",
    );
    const params = new URLSearchParams({
      client_id: "client-1",
      redirect_to: "https://external.example.test/callback",
      state: "external-state",
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
      nonce: "oidc-nonce",
      scope: "openid profile",
      resource: "https://api.example.test/",
    });
    expect((await request(`/auth/passkey/start?${params.toString()}`)).status).toBe(303);
    const page = await request("/auth/passkey");
    csrf = (await page.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)![1];
    const data = await options();
    Object.assign(fixture.snapshot, { challenge: data.options.challenge });
    return fixture.assertion(2);
  }
  it("preserves service, state, PKCE S256, nonce, scope and resource generation in the normal code", async () => {
    const response = await serviceCeremony();
    const res = await finish(response);
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("Location")!);
    expect(target.origin).toBe("https://external.example.test");
    expect(target.searchParams.get("state")).toBe("external-state");
    expect(
      sqlite
        .prepare(
          "SELECT service_id,nonce,code_challenge,code_challenge_method,scope,provider,resource,resource_server_id FROM auth_codes",
        )
        .get(),
    ).toEqual({
      service_id: "service-1",
      nonce: "oidc-nonce",
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
      scope: "openid profile",
      provider: "passkey",
      resource: "https://api.example.test/",
      resource_server_id: "resource-1",
    });
  });
  it.each(["service", "redirect", "resource", "resource-generation"])(
    "rejects a changed current registration (%s)",
    async (kind) => {
      const response = await serviceCeremony();
      if (kind === "service") sqlite.exec("DELETE FROM services");
      if (kind === "redirect") sqlite.exec("DELETE FROM service_redirect_uris");
      if (kind === "resource") sqlite.exec("DELETE FROM resource_servers");
      if (kind === "resource-generation")
        sqlite.exec("UPDATE resource_servers SET id='new-generation'");
      const res = await finish(response);
      expect(res.status).toBe(400);
      expect(codeCount()).toBe(0);
    },
  );
  it("uses finalizer current resource subject restrictions before issuing a code", async () => {
    const response = await serviceCeremony();
    sqlite.exec(`UPDATE resource_servers SET allowed_subjects='["someone-else"]'`);
    const res = await finish(response);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
    expect(codeCount()).toBe(0);
  });
  it("keeps the expected resource generation across the finalizer's second lookup", async () => {
    const response = await serviceCeremony();
    let reads = 0;
    beforeSql = (sql) => {
      if (sql === "SELECT * FROM resource_servers WHERE uri = ?" && ++reads === 2) {
        sqlite.exec(
          "UPDATE resource_servers SET id='replacement-between-current-check-and-finalizer'",
        );
        beforeSql = undefined;
      }
    };
    const res = await finish(response);
    expect(reads).toBe(2);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("invalid_target");
    expect(codeCount()).toBe(0);
  });
  it("rejects missing PKCE and oversized aggregate state rather than truncating", async () => {
    sqlite.exec(
      "INSERT INTO services VALUES('service-1','client-1'); INSERT INTO service_redirect_uris(id,service_id,uri) VALUES('redirect-1','service-1','https://external.example.test/callback');",
    );
    expect(
      (
        await request(
          "/auth/passkey/start?client_id=client-1&redirect_to=https%3A%2F%2Fexternal.example.test%2Fcallback&state=state",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/auth/passkey/start?redirect_to=${encodeURIComponent(bff)}&state=${"a".repeat(1024)}&scope=${"b".repeat(1024)}`,
        )
      ).status,
    ).toBe(400);
    expect(cookies.size).toBe(0);
  });
});
