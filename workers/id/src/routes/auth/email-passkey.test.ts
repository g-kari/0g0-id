/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { IdpEnv } from "@0g0-id/shared";
import { bodyLimitMiddleware } from "@0g0-id/shared";
import { syntheticAuthenticator } from "../../utils/__fixtures__/webauthn/synthetic";
import emailRoutes from "./email-passkey";
import nativeRoutes from "./native-passkey";
import { openNativeCookie } from "../../utils/native-login-cookie";

const origin = "https://dev.dontneeda.pw";
const callback = "https://user.dontneeda.pw/auth/callback";
const schema = readFileSync(
  fileURLToPath(new NodeURL("../../../../../docs/proposals/passkey-schema.sql", import.meta.url)),
  "utf8",
);
const base = `PRAGMA foreign_keys=ON;
CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,email_verified INTEGER NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',banned_at TEXT);
CREATE TABLE account_lockouts(user_id TEXT PRIMARY KEY,failed_attempts INTEGER DEFAULT 0,locked_until TEXT,last_failed_at TEXT,updated_at TEXT);
CREATE TABLE services(id TEXT PRIMARY KEY,client_id TEXT NOT NULL UNIQUE);
CREATE TABLE service_redirect_uris(id TEXT PRIMARY KEY,service_id TEXT,uri TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE resource_servers(id TEXT PRIMARY KEY,uri TEXT UNIQUE,allowed_subjects TEXT);
CREATE TABLE auth_codes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,service_id TEXT,code_hash TEXT NOT NULL,redirect_to TEXT NOT NULL,expires_at TEXT NOT NULL,nonce TEXT,code_challenge TEXT,code_challenge_method TEXT,scope TEXT,provider TEXT,resource TEXT,resource_server_id TEXT);
CREATE TABLE login_events(id TEXT PRIMARY KEY,user_id TEXT,provider TEXT,ip_address TEXT,user_agent TEXT,country TEXT,success INTEGER);`;

describe("default-off email signup HTTP, real SQLite and WebAuthn, synthetic mail only", () => {
  let sqlite: DatabaseSync;
  let env: IdpEnv;
  let app: Hono;
  let cookies: Map<string, string>;
  let csrf: string;
  let tasks: Promise<unknown>[];
  let writes: number;
  let afterBatch: (() => void) | undefined;
  let beforeSql: ((sql: string) => void) | undefined;
  let send: ReturnType<typeof vi.fn<(message: unknown) => Promise<{ messageId: string }>>>;
  let messages: unknown[];
  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(base + schema);
    writes = 0;
    tasks = [];
    cookies = new Map();
    afterBatch = undefined;
    beforeSql = undefined;
    messages = [];
    function prepare(sql: string) {
      function statement(values: SQLInputValue[]) {
        function execute<T>(kind: "get" | "all" | "run"): T {
          beforeSql?.(sql);
          if (/^(INSERT|UPDATE|DELETE)/.test(sql)) writes++;
          return sqlite.prepare(sql)[kind](...values) as T;
        }
        return {
          sql,
          values,
          async first<T>() {
            return execute<T | undefined>("get") ?? null;
          },
          async all<T>() {
            return { results: execute<T[]>("all") };
          },
          async run() {
            return {
              meta: { changes: Number(execute<{ changes: number | bigint }>("run").changes) },
            };
          },
        };
      }
      return { ...statement([]), bind: (...values: SQLInputValue[]) => statement(values) };
    }
    const db = {
      prepare,
      async batch(statements: { sql: string; values: SQLInputValue[] }[]) {
        sqlite.exec("BEGIN IMMEDIATE");
        let results;
        try {
          results = statements.map(({ sql, values }) => {
            beforeSql?.(sql);
            writes++;
            return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
          });
          sqlite.exec("COMMIT");
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
        afterBatch?.();
        return results;
      },
    } as unknown as D1Database;
    send = vi.fn(async (message: unknown) => {
      messages.push(message);
      return { messageId: "synthetic-message" };
    });
    env = {
      DB: db,
      IDP_ORIGIN: origin,
      USER_ORIGIN: "https://user.dontneeda.pw",
      ADMIN_ORIGIN: "https://admin.dontneeda.pw",
      COOKIE_SECRET: "synthetic-cookie-secret-".repeat(3),
      PASSKEY_LOGIN_ENABLED: "true",
      EMAIL_PASSKEY_SIGNUP_ENABLED: "true",
      VERIFICATION_EMAIL_ENABLED: "true",
      VERIFICATION_EMAIL_FROM: "noreply@id.0g0.xyz",
      VERIFICATION_EMAIL: { send },
      EMAIL_SIGNUP_DAILY_LIMIT: "20",
      RATE_LIMITER_AUTH: { limit: async () => ({ success: true }) },
      RATE_LIMITER_EMAIL_SIGNUP: { limit: async () => ({ success: true }) },
      RATE_LIMITER_EMAIL_SIGNUP_GLOBAL: { limit: async () => ({ success: true }) },
    } as unknown as IdpEnv;
    app = new Hono();
    app.use("*", bodyLimitMiddleware());
    app.route("/auth/email", emailRoutes);
    app.route("/auth/passkey", nativeRoutes);
  });
  afterEach(async () => {
    await Promise.allSettled(tasks);
    sqlite.close();
    vi.useRealTimers();
  });
  function jar() {
    return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  async function request(path: string, init: RequestInit = {}, remember = true) {
    const headers = new Headers(init.headers);
    if (!headers.has("Cookie")) headers.set("Cookie", jar());
    const execution = {
      waitUntil: (task: Promise<unknown>) => tasks.push(task),
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    const res = await app.request(`${origin}${path}`, { ...init, headers }, env, execution);
    if (remember)
      for (const cookie of (
        res.headers as unknown as { getSetCookie(): string[] }
      ).getSetCookie()) {
        const pair = cookie.split(";", 1)[0];
        const at = pair.indexOf("=");
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
    return res;
  }
  async function start() {
    const res = await request(
      `/auth/email/signup/start?redirect_to=${encodeURIComponent(callback)}&state=bff-state`,
    );
    expect(res.status).toBe(303);
    const cookie = await openNativeCookie(
      decodeURIComponent(cookies.get("__Host-idp-email-signup")!),
      env.COOKIE_SECRET,
      "email-signup",
      origin,
    );
    csrf = cookie!.csrf as string;
    return cookie!;
  }
  function json(
    path: string,
    body: Record<string, unknown>,
    init: RequestInit = {},
    remember = true,
  ) {
    return request(
      path,
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...init,
      },
      remember,
    );
  }
  function mail(email = "new@example.test", remember = true) {
    return json("/auth/email/start", { csrf, confirm: true, email }, {}, remember);
  }
  async function token() {
    await Promise.all(tasks);
    expect(messages.length).toBeGreaterThan(0);
    return (messages.at(-1) as { text: string }).text.match(/#token=([A-Za-z0-9_-]{43})/)![1];
  }
  async function verified() {
    await start();
    expect((await mail()).status).toBe(202);
    const proof = await token();
    const res = await json("/auth/email/verify", { csrf, confirm: true, token: proof });
    expect(res.status).toBe(200);
    return { proof, res };
  }
  async function registrationOptions(remember = true, name = "Synthetic User") {
    return json("/auth/email/registration/options", { csrf, confirm: true, name }, {}, remember);
  }
  function count(table: string) {
    return Number(sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
  }

  it.each([undefined, "false", "1", true])(
    "performs no DB/mail work when the signup flag is not literal true (%s)",
    async (flag) => {
      Object.assign(env, { EMAIL_PASSKEY_SIGNUP_ENABLED: flag });
      expect((await request("/auth/email/signup/start")).status).toBe(404);
      expect(writes).toBe(0);
      expect(send).not.toHaveBeenCalled();
      const landing = await request("/auth/email/verify");
      expect(landing.status).toBe(404);
      expect(await landing.text()).toContain("history.replaceState");
    },
  );
  it.each([
    "VERIFICATION_EMAIL_ENABLED",
    "VERIFICATION_EMAIL",
    "VERIFICATION_EMAIL_FROM",
    "EMAIL_SIGNUP_DAILY_LIMIT",
    "RATE_LIMITER_EMAIL_SIGNUP",
    "RATE_LIMITER_EMAIL_SIGNUP_GLOBAL",
    "RATE_LIMITER_AUTH",
    "PASSKEY_LOGIN_ENABLED",
  ])("fails closed without required configuration %s", async (field) => {
    Object.assign(env, { [field]: undefined });
    expect((await request("/auth/email/signup/start")).status).toBe(503);
    expect(writes).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "1.5", " 10", "9007199254740991"])(
    "rejects unusable budget settings %s",
    async (limit) => {
      env.EMAIL_SIGNUP_DAILY_LIMIT = limit;
      expect((await request("/auth/email/signup/start")).status).toBe(503);
      expect(writes).toBe(0);
    },
  );
  it("reserves indistinguishable encrypted server intent state before any email or DB allocation", async () => {
    const state = await start();
    expect(state.intentId).toMatch(/^[a-f0-9-]{36}$/);
    expect(writes).toBe(0);
    expect(Object.keys(state).sort()).toEqual([
      "browserHash",
      "continuation",
      "csrf",
      "exp",
      "intentId",
      "purpose",
      "transaction",
    ]);
    expect(jar()).not.toContain(state.intentId as string);
  });
  it("returns the same 202 body and no outcome cookie for new, existing, invalid and suppressed mail", async () => {
    await start();
    const first = await mail();
    const body = await first.text();
    expect(first.status).toBe(202);
    expect(first.headers.get("Set-Cookie")).toBeNull();
    await Promise.all(tasks);
    sqlite.exec(
      "INSERT INTO users VALUES('existing','existing@example.test',1,'Existing','user',NULL)",
    );
    for (const email of ["existing@example.test", "invalid", "new@example.test"]) {
      const res = await mail(email);
      expect(res.status).toBe(202);
      expect(await res.text()).toBe(body);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("shows the shorter browser expiry in the email, without extending either proof or state", async () => {
    const state = await start();
    await mail();
    await Promise.all(tasks);
    const expiry = new Date((state.exp as number) * 1000).toISOString();
    const message = messages[0] as { text: string; html: string };
    expect(message.text).toContain(`有効期限: ${expiry}`);
    expect(message.html).toContain(expiry);
    expect(
      Number(sqlite.prepare("SELECT expires_at FROM email_signup_intents").get()!.expires_at),
    ).toBeGreaterThan(state.exp as number);
    expect(await (await request("/auth/email/signup")).text()).toContain("登録開始から10分以内");
  });
  it("permits only one allocation and one synthetic send under concurrent or repeated POST", async () => {
    await start();
    const results = await Promise.all(Array.from({ length: 5 }, () => mail()));
    expect(results.every((r) => r.status === 202)).toBe(true);
    await Promise.all(tasks);
    expect(count("email_signup_intents")).toBe(1);
    expect(count("email_signup_outbox")).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    await mail();
    await Promise.all(tasks);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not send or recreate a token after a lost successful insert response", async () => {
    await start();
    afterBatch = () => {
      afterBatch = undefined;
      throw new Error("lost insert response");
    };
    expect((await mail()).status).toBe(202);
    const hash = sqlite.prepare("SELECT token_hash FROM email_signup_intents").get()!.token_hash;
    expect((await mail()).status).toBe(202);
    await Promise.all(tasks);
    expect(send).not.toHaveBeenCalled();
    expect(count("email_signup_intents")).toBe(1);
    expect(sqlite.prepare("SELECT token_hash FROM email_signup_intents").get()!.token_hash).toBe(
      hash,
    );
  });
  it("does not wait for the provider and never resends an uncertain send", async () => {
    await start();
    let reject!: (error: Error) => void;
    send.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const res = await mail();
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    reject(new Error("synthetic uncertain provider result"));
    await Promise.all(tasks);
    expect(sqlite.prepare("SELECT state FROM email_signup_outbox").get()!.state).toBe("uncertain");
    await mail();
    await Promise.all(tasks);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not retry a send after final ledger persistence fails", async () => {
    await start();
    beforeSql = (sql) => {
      if (sql.includes("SET state = ?, message_id"))
        throw new Error("synthetic ledger unavailable");
    };
    await mail();
    await Promise.all(tasks);
    await mail();
    await Promise.all(tasks);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT state FROM email_signup_outbox").get()!.state).toBe("claimed");
  });
  it("suppresses IP/global rate limits without account lookup or sends", async () => {
    await start();
    env.RATE_LIMITER_EMAIL_SIGNUP = { limit: async () => ({ success: false }) };
    expect((await mail()).status).toBe(202);
    expect(writes).toBe(0);
    env.RATE_LIMITER_EMAIL_SIGNUP = { limit: async () => ({ success: true }) };
    env.RATE_LIMITER_EMAIL_SIGNUP_GLOBAL = { limit: async () => ({ success: false }) };
    expect((await mail()).status).toBe(202);
    expect(writes).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
  it("scanner GET and HEAD cannot consume email proof or create an account", async () => {
    await start();
    await mail();
    await token();
    const previous = writes;
    for (const method of ["GET", "HEAD"])
      expect((await request("/auth/email/verify", { method })).status).toBe(200);
    expect(writes).toBe(previous);
    expect(count("users")).toBe(0);
    expect(
      sqlite.prepare("SELECT verified_at FROM email_signup_intents").get()!.verified_at,
    ).toBeNull();
    expect(count("auth_codes")).toBe(0);
  });
  it.each([undefined, "null", "https://user.dontneeda.pw", `${origin}/`])(
    "requires an exact origin before mail or proof (%s)",
    async (value) => {
      await start();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (value) headers.Origin = value;
      expect(
        (
          await json(
            "/auth/email/start",
            { csrf, confirm: true, email: "new@example.test" },
            { headers },
          )
        ).status,
      ).toBe(403);
      expect(writes).toBe(0);
    },
  );
  it("requires CSRF and explicit confirmation, refuses caller-controlled intent IDs and bounds total bytes", async () => {
    await start();
    for (const body of [
      { csrf, confirm: false, email: "new@example.test" },
      { csrf: "x".repeat(43), confirm: true, email: "new@example.test" },
    ])
      expect((await json("/auth/email/start", body)).status).toBe(403);
    expect(
      (
        await json("/auth/email/start", {
          csrf,
          confirm: true,
          email: "new@example.test",
          intentId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/auth/email/start", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json", "Content-Length": "1" },
          body: "x".repeat(32769),
        })
      ).status,
    ).toBe(413);
    expect(writes).toBe(0);
  });
  it("binds proof to the original browser/transaction and verifies server expiry before stable ID reuse", async () => {
    await start();
    await mail();
    const proof = await token();
    const originalCookies = new Map(cookies);
    await start();
    expect((await json("/auth/email/verify", { csrf, confirm: true, token: proof })).status).toBe(
      400,
    );
    cookies = originalCookies;
    const raw = await openNativeCookie(
      decodeURIComponent(cookies.get("__Host-idp-email-signup")!),
      env.COOKIE_SECRET,
      "email-signup",
      origin,
    );
    csrf = raw!.csrf as string;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 601000);
    expect((await mail()).status).toBe(403);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("only the winning explicit proof gets confidential enrollment authority", async () => {
    await start();
    await mail();
    const proof = await token();
    const original = jar();
    const results = await Promise.all(
      [1, 2].map(() =>
        json(
          "/auth/email/verify",
          { csrf, confirm: true, token: proof },
          { headers: { Cookie: original, Origin: origin, "Content-Type": "application/json" } },
          false,
        ),
      ),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 400]);
    const winner = results.find((r) => r.status === 200)!;
    expect(await winner.json()).toEqual({ next: "/auth/email/register" });
    expect(winner.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(winner.headers.get("Set-Cookie")).not.toContain(proof);
    expect(count("users")).toBe(0);
    expect(count("auth_codes")).toBe(0);
  });
  it("resumes after lost proof body if its authority cookie arrived, without reusing the proof", async () => {
    const { proof } = await verified();
    const before = sqlite
      .prepare("SELECT authority_hash FROM email_signup_intents")
      .get()!.authority_hash;
    expect((await json("/auth/email/verify", { csrf, confirm: true, token: proof })).status).toBe(
      200,
    );
    expect(
      sqlite.prepare("SELECT authority_hash FROM email_signup_intents").get()!.authority_hash,
    ).toBe(before);
    expect(count("auth_codes")).toBe(0);
  });
  it("does not reissue lost authority or automatically send again", async () => {
    await start();
    await mail();
    const proof = await token();
    expect(
      (await json("/auth/email/verify", { csrf, confirm: true, token: proof }, {}, false)).status,
    ).toBe(200);
    expect((await json("/auth/email/verify", { csrf, confirm: true, token: proof })).status).toBe(
      400,
    );
    await mail();
    await Promise.all(tasks);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("resumes the same pending registration after an options response is lost", async () => {
    await verified();
    const first = await registrationOptions(false);
    expect(first.status).toBe(200);
    const a = await first.json<{ options: { challenge: string } }>();
    const second = await registrationOptions();
    const b = await second.json<{ options: { challenge: string } }>();
    expect(a.options.challenge).toBe(b.options.challenge);
    expect(count("passkey_signup_pending")).toBe(1);
    expect(Object.keys(b)).toEqual(["options"]);
    expect(JSON.stringify(b)).not.toMatch(/authority|receipt|pendingId|browserBinding/);
    expect(count("users")).toBe(0);
    expect(count("auth_codes")).toBe(0);
  });
  it.each(["", " ", "x".repeat(101), "bad\nname", "bad\u007fname", "bad\u0085name"])(
    "rejects an invalid registration display name",
    async (name) => {
      await verified();
      expect((await registrationOptions(true, name)).status).toBe(400);
      expect(count("passkey_signup_pending")).toBe(0);
    },
  );

  async function serviceStart() {
    sqlite.exec(
      "INSERT INTO services VALUES('service-1','client-1'); INSERT INTO service_redirect_uris(id,service_id,uri) VALUES('redirect-1','service-1','https://client.example.test/callback'); INSERT INTO resource_servers VALUES('resource-1','https://api.example.test/',NULL)",
    );
    const query = new URLSearchParams({
      client_id: "client-1",
      redirect_to: "https://client.example.test/callback",
      state: "service-state",
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
      resource: "https://api.example.test/",
    });
    expect((await request(`/auth/email/signup/start?${query.toString()}`)).status).toBe(303);
    const state = await openNativeCookie(
      decodeURIComponent(cookies.get("__Host-idp-email-signup")!),
      env.COOKIE_SECRET,
      "email-signup",
      origin,
    );
    csrf = state!.csrf as string;
  }
  it.each(["service", "redirect", "resource"])(
    "rechecks current %s before allocating email",
    async (change) => {
      await serviceStart();
      if (change === "service") sqlite.exec("UPDATE services SET client_id='changed'");
      if (change === "redirect") sqlite.exec("DELETE FROM service_redirect_uris");
      if (change === "resource") sqlite.exec("UPDATE resource_servers SET id='resource-2'");
      expect((await mail()).status).toBe(400);
      expect(count("email_signup_intents")).toBe(0);
      expect(send).not.toHaveBeenCalled();
    },
  );
  it("does not consume email proof or issue options after resource generation replacement", async () => {
    await serviceStart();
    await mail();
    const proof = await token();
    sqlite.exec("UPDATE resource_servers SET id='resource-2'");
    expect((await json("/auth/email/verify", { csrf, confirm: true, token: proof })).status).toBe(
      400,
    );
    expect(
      sqlite.prepare("SELECT verified_at FROM email_signup_intents").get()!.verified_at,
    ).toBeNull();
    sqlite.exec("UPDATE resource_servers SET id='resource-1'");
    expect((await json("/auth/email/verify", { csrf, confirm: true, token: proof })).status).toBe(
      200,
    );
    sqlite.exec("UPDATE resource_servers SET id='resource-2'");
    expect((await registrationOptions()).status).toBe(400);
    expect(count("passkey_signup_pending")).toBe(0);
  });
  it("cannot substitute enrollment authority as signup state or native login proof", async () => {
    const { res } = await verified();
    const encrypted = cookies.get("__Host-idp-email-enrollment")!;
    const raw = await openNativeCookie(
      decodeURIComponent(encrypted),
      env.COOKIE_SECRET,
      "email-enrollment",
      origin,
    );
    expect(raw!.authority).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await res.text()).not.toContain(raw!.authority as string);
    for (const purpose of ["continuation", "browser", "email-browser", "email-signup"] as const)
      expect(
        await openNativeCookie(decodeURIComponent(encrypted), env.COOKIE_SECRET, purpose, origin),
      ).toBeNull();
    expect(
      await openNativeCookie(
        decodeURIComponent(encrypted),
        env.COOKIE_SECRET,
        "email-enrollment",
        "https://other.example.test",
      ),
    ).toBeNull();
    cookies.set("__Host-idp-email-signup", encrypted);
    expect((await registrationOptions()).status).toBe(403);
    expect(count("auth_codes")).toBe(0);
  });

  async function registration() {
    await verified();
    const res = await registrationOptions();
    expect(res.status).toBe(200);
    const data = await res.json<{ options: { challenge: string; user: { id: string } } }>();
    const fixture = await syntheticAuthenticator();
    const id = isoBase64URL.toBuffer(fixture.stored.credential.id);
    const authData = new Uint8Array(
      32 + 1 + 4 + 16 + 2 + id.length + fixture.stored.credential.publicKey.length,
    );
    authData.set(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("dev.dontneeda.pw")),
      ),
    );
    authData[32] = 0x45;
    new DataView(authData.buffer).setUint16(53, id.length);
    authData.set(id, 55);
    authData.set(fixture.stored.credential.publicKey, 55 + id.length);
    const response: RegistrationResponseJSON = {
      id: fixture.stored.credential.id,
      rawId: fixture.stored.credential.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromUTF8String(
          JSON.stringify({
            type: "webauthn.create",
            challenge: data.options.challenge,
            origin,
            crossOrigin: false,
          }),
        ),
        attestationObject: isoBase64URL.fromBuffer(
          isoCBOR.encode(
            new Map<string, string | Uint8Array | Map<string, never>>([
              ["fmt", "none"],
              ["attStmt", new Map<string, never>()],
              ["authData", authData],
            ]),
          ),
        ),
        transports: ["internal"],
      },
    };
    return { response, fixture, handle: data.options.user.id };
  }
  function complete(response: RegistrationResponseJSON, remember = true) {
    return request(
      "/auth/email/registration/complete",
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, credential: JSON.stringify(response) }).toString(),
      },
      remember,
    );
  }
  async function signIn(
    fixture: Awaited<ReturnType<typeof syntheticAuthenticator>>,
    handle: string,
  ) {
    const page = await request("/auth/passkey");
    expect(page.status).toBe(200);
    const nativeCsrf = (await page.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)![1];
    const options = await json("/auth/passkey/options", { csrf: nativeCsrf, confirm: true });
    const data = await options.json<{ options: { challenge: string } }>();
    Object.assign(fixture.snapshot, { challenge: data.options.challenge });
    const response = await fixture.assertion(1);
    response.response.userHandle = handle;
    return request("/auth/passkey/verify", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf: nativeCsrf,
        credential: JSON.stringify(response),
      }).toString(),
    });
  }
  it("requires a new real signature after actual attestation-none signup before issuing a code", async () => {
    const { response, fixture, handle } = await registration();
    const result = await complete(response);
    expect(result.status).toBe(303);
    expect(result.headers.get("Location")).toBe("/auth/passkey");
    expect(count("users")).toBe(1);
    expect(count("passkey_credentials")).toBe(1);
    expect(count("auth_codes")).toBe(0);
    expect(count("passkey_challenges")).toBe(0);
    expect(result.headers.get("Set-Cookie")).not.toContain(fixture.stored.credential.id);
    const login = await signIn(fixture, handle);
    expect(login.status).toBe(302);
    expect(count("auth_codes")).toBe(1);
    const target = new URL(login.headers.get("Location")!);
    expect(target.searchParams.get("state")).toBe("bff-state");
  });
  it("a receipt cannot authenticate, even when a commit response is uncertain", async () => {
    const { response, fixture, handle } = await registration();
    afterBatch = () => {
      afterBatch = undefined;
      throw new Error("lost final commit response");
    };
    const result = await complete(response);
    expect(result.status).toBe(303);
    expect(count("users")).toBe(1);
    expect(count("auth_codes")).toBe(0);
    expect((await signIn(fixture, handle)).status).toBe(302);
    expect(count("auth_codes")).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("lost registration HTTP response does not recreate an account or resend mail", async () => {
    const { response } = await registration();
    expect((await complete(response, false)).status).toBe(303);
    expect((await complete(response)).status).toBe(400);
    expect(count("users")).toBe(1);
    expect(count("passkey_credentials")).toBe(1);
    expect(count("auth_codes")).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("never auto-links an OAuth account appearing between email proof and final registration", async () => {
    const { response } = await registration();
    sqlite.exec(
      "INSERT INTO users VALUES('oauth-existing','new@example.test',1,'Existing','user',NULL)",
    );
    expect((await complete(response)).status).toBe(400);
    expect(count("users")).toBe(1);
    expect(count("passkey_credentials")).toBe(0);
    expect(count("auth_codes")).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("requires fresh signed login, never another registration, after a lost completed response", async () => {
    const { response, fixture, handle } = await registration();
    expect((await complete(response, false)).status).toBe(303);
    expect((await registrationOptions()).status).toBe(400);
    const next = await request("/auth/email/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, confirm: "true" }).toString(),
    });
    expect(next.status).toBe(303);
    expect(count("auth_codes")).toBe(0);
    expect(count("users")).toBe(1);
    expect((await signIn(fixture, handle)).status).toBe(302);
    expect(count("auth_codes")).toBe(1);
  });
  it("requires the created credential generation, not another otherwise valid passkey", async () => {
    const { response, fixture, handle } = await registration();
    expect((await complete(response)).status).toBe(303);
    sqlite.exec("UPDATE passkey_credentials SET registration_id='replaced-generation'");
    expect((await signIn(fixture, handle)).status).toBe(400);
    expect(count("auth_codes")).toBe(0);
  });
  it("rechecks verified-email and ban policy at fresh authentication", async () => {
    const { response, fixture, handle } = await registration();
    expect((await complete(response)).status).toBe(303);
    sqlite.exec("UPDATE users SET banned_at='2026-11-07T00:00:00Z'");
    expect((await signIn(fixture, handle)).status).toBe(400);
    expect(count("auth_codes")).toBe(0);
  });
});
