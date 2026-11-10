/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { beforeEach, afterEach, describe, it, expect, vi } from "vite-plus/test";
import { Hono } from "hono";
import type { IdpEnv, TokenPayload } from "@0g0-id/shared";
import { signCookie, COOKIE_NAMES } from "@0g0-id/shared";
import { createMockIdpEnv } from "../../../../../packages/shared/src/db/test-helpers";
import authRoutes from "./index";

const DISCORD_ID = "123456789012345678";
const STEAM_ID = "76561198000000000";
const subject = "10000000-0000-4000-8000-000000000001";
const ns = "http://specs.openid.net/auth/2.0";

function adapter(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = (values: SQLInputValue[] = []) => ({
        bind: (...bound: SQLInputValue[]) => statement(bound),
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...values) };
        },
        async run() {
          return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
        },
      });
      return statement();
    },
  } as unknown as D1Database;
}

function steamCallback(
  returnTo: string,
  nonce = new Date().toISOString().slice(0, 19) + "Zunique",
) {
  const url = new URL(returnTo);
  const identity = `https://steamcommunity.com/openid/id/${STEAM_ID}`;
  for (const [key, value] of Object.entries({
    ns,
    mode: "id_res",
    op_endpoint: "https://steamcommunity.com/openid/login",
    claimed_id: identity,
    identity,
    return_to: returnTo,
    response_nonce: nonce,
    assoc_handle: "test-assoc",
    signed: "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    sig: "a".repeat(28),
  }))
    url.searchParams.set(`openid.${key}`, value);
  return url;
}

describe("opt-in social login routes with real SQLite and provider HTTP stubs", () => {
  let sqlite: DatabaseSync;
  let env: IdpEnv;
  let app: Hono<{ Bindings: IdpEnv; Variables: { user: TokenPayload } }>;
  let upstream: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    const migrations = new NodeURL("../../../../../migrations/", import.meta.url);
    for (const name of readdirSync(migrations)
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      sqlite.exec(readFileSync(new NodeURL(name, migrations), "utf8"));
    }
    sqlite.exec(
      readFileSync(
        new NodeURL("../../../../../docs/proposals/social-login-schema.sql", import.meta.url),
        "utf8",
      ),
    );
    env = createMockIdpEnv({
      DB: adapter(sqlite),
      DISCORD_LOGIN_ENABLED: "true",
      STEAM_LOGIN_ENABLED: "true",
      DISCORD_CLIENT_ID: "111111111111111111",
      DISCORD_CLIENT_SECRET: "test-client-secret",
    });
    app = new Hono();
    app.route("/auth", authRoutes);
    app.onError((_err, c) => c.json({ error: "safe failure" }, 500));
    upstream = vi.fn(async (input: string) => {
      if (input === "https://discord.com/api/oauth2/token")
        return Response.json({
          access_token: "private-provider-access",
          token_type: "Bearer",
          scope: "identify",
          refresh_token: "must-discard",
        });
      if (input === "https://discord.com/api/v10/users/@me")
        return Response.json({
          id: DISCORD_ID,
          username: "Discord name",
          avatar: null,
          email: "ignored@example.com",
        });
      if (input === "https://steamcommunity.com/openid/login")
        return new Response(`ns:${ns}\nis_valid:true\n`);
      throw new Error("Unexpected upstream");
    });
    vi.stubGlobal("fetch", upstream);
  });
  afterEach(() => {
    sqlite.close();
    vi.unstubAllGlobals();
  });
  const request = (url: string | URL, init?: RequestInit) => app.request(String(url), init, env);
  async function begin(provider: "discord" | "steam", linkToken?: string) {
    const params = new URLSearchParams({
      provider,
      redirect_to: `${env.USER_ORIGIN}/auth/callback`,
      state: "bff-state",
    });
    let res: Response;
    if (linkToken) {
      params.set("link_token", linkToken);
      res = await request(`${env.IDP_ORIGIN}/auth/login`, {
        method: "POST",
        headers: { Origin: env.USER_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      });
    } else res = await request(`${env.IDP_ORIGIN}/auth/login?${params.toString()}`);
    expect(res.status).toBe(linkToken ? 200 : 302);
    const cookies = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const location = linkToken
      ? (await res.text())
          .match(/id="provider-continue" href="([^"]+)"/)![1]!
          .replaceAll("&amp;", "&")
      : res.headers.get("Location")!;
    const auth = new URL(location);
    const callback =
      provider === "discord"
        ? new URL(
            `${env.IDP_ORIGIN}/auth/callback?${new URLSearchParams({ state: auth.searchParams.get("state")!, code: "test-code", iss: "https://discord.com" }).toString()}`,
          )
        : steamCallback(auth.searchParams.get("openid.return_to")!);
    return { auth, callback, cookies };
  }
  function codes() {
    return Number(sqlite.prepare("SELECT count(*) AS n FROM auth_codes").get()!.n);
  }
  async function token(provider: "discord" | "steam", changes = {}) {
    return signCookie(
      JSON.stringify({
        purpose: "link",
        provider,
        sub: subject,
        jti: crypto.randomUUID(),
        exp: Date.now() + 120000,
        ...changes,
      }),
      env.COOKIE_SECRET,
    );
  }
  function existing() {
    sqlite
      .prepare(
        "INSERT INTO users (id, google_sub, email, email_verified, name) VALUES (?, 'google-existing', 'owner@example.com', 1, 'Owner')",
      )
      .run(subject);
  }

  it.each(["discord", "steam"] as const)(
    "completes %s once and binds the issued BFF authorization code",
    async (provider) => {
      const flow = await begin(provider);
      const res = await request(flow.callback, { headers: { Cookie: flow.cookies } });
      expect(res.status).toBe(302);
      const target = new URL(res.headers.get("Location")!);
      expect(target.origin).toBe(env.USER_ORIGIN);
      expect(target.searchParams.get("state")).toBe("bff-state");
      expect(target.searchParams.get("code")).toHaveLength(43);
      const row = sqlite.prepare(`SELECT * FROM users WHERE ${provider}_sub IS NOT NULL`).get()!;
      expect(row.email_verified).toBe(0);
      expect(row.role).toBe("user");
      expect(String(row.email)).not.toContain(provider === "discord" ? DISCORD_ID : STEAM_ID);
      expect(JSON.stringify(sqlite.prepare("SELECT * FROM auth_codes").all())).not.toContain(
        "private-provider-access",
      );
      expect(sqlite.prepare("SELECT provider FROM auth_codes").get()!.provider).toBe(provider);
      const before = upstream.mock.calls.length;
      expect((await request(flow.callback, { headers: { Cookie: flow.cookies } })).status).toBe(
        400,
      );
      expect(upstream).toHaveBeenCalledTimes(before);
      expect(codes()).toBe(1);
    },
  );
  it("requests only Discord identify with S256 and uses the pinned callback", async () => {
    const flow = await begin("discord");
    expect(flow.auth.searchParams.get("scope")).toBe("identify");
    expect(flow.auth.searchParams.get("code_challenge_method")).toBe("S256");
    await request(flow.callback, { headers: { Cookie: flow.cookies } });
    const body = new URLSearchParams(upstream.mock.calls[0]![1].body);
    expect(body.get("redirect_uri")).toBe(`${env.IDP_ORIGIN}/auth/callback`);
    expect(body.get("code_verifier")).toHaveLength(43);
  });
  it.each([undefined, "false", "TRUE", "1"])(
    "is default-off for flag %s without touching DB or network",
    async (flag) => {
      env.DISCORD_LOGIN_ENABLED = flag;
      env.STEAM_LOGIN_ENABLED = flag;
      env.DB = {
        prepare: vi.fn(() => {
          throw new Error("must not access DB");
        }),
      } as unknown as D1Database;
      for (const provider of ["discord", "steam"])
        expect(
          (
            await request(
              `${env.IDP_ORIGIN}/auth/login?provider=${provider}&redirect_to=${env.USER_ORIGIN}/auth/callback&state=bff`,
            )
          ).status,
        ).toBe(400);
      const res = await request(`${env.IDP_ORIGIN}/auth/providers`);
      expect((await res.json<{ data: Record<string, boolean> }>()).data).toMatchObject({
        discord: false,
        steam: false,
      });
      expect(env.DB.prepare).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    },
  );
  it("fails closed with flags on but schema missing", async () => {
    sqlite.exec("DROP TABLE social_login_transactions");
    const res = await request(`${env.IDP_ORIGIN}/auth/providers`);
    expect((await res.json<{ data: Record<string, boolean> }>()).data).toMatchObject({
      discord: false,
      steam: false,
    });
    expect(
      (
        await request(
          `${env.IDP_ORIGIN}/auth/login?provider=steam&redirect_to=${env.USER_ORIGIN}/auth/callback&state=bff`,
        )
      ).status,
    ).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(["issuer", "state", "code", "origin", "route", "expired", "mixed-cookie"])(
    "rejects Discord %s before upstream",
    async (change) => {
      const flow = await begin("discord");
      if (change === "issuer") flow.callback.searchParams.set("iss", "https://evil.example");
      if (change === "state")
        flow.callback.searchParams.append("state", flow.callback.searchParams.get("state")!);
      if (change === "code") flow.callback.searchParams.append("code", "second");
      if (change === "origin") flow.callback.host = "evil.example";
      if (change === "route") flow.callback.pathname = "/auth/steam/callback";
      if (change === "expired")
        sqlite.exec("UPDATE social_login_transactions SET expires_at=unixepoch()");
      if (change === "mixed-cookie") {
        const second = await begin("discord");
        const firstState = flow.cookies
          .split("; ")
          .find((c) => c.startsWith(COOKIE_NAMES.IDP_STATE + "="))!;
        flow.cookies =
          firstState +
          "; " +
          second.cookies.split("; ").find((c) => c.startsWith(COOKIE_NAMES.IDP_PKCE + "="))!;
      }
      expect((await request(flow.callback, { headers: { Cookie: flow.cookies } })).status).toBe(
        400,
      );
      expect(upstream).not.toHaveBeenCalled();
      expect(codes()).toBe(0);
    },
  );
  it("consumes a Discord denial without reflecting provider error details", async () => {
    const flow = await begin("discord");
    flow.callback.searchParams.delete("code");
    flow.callback.searchParams.set("error", "untrusted");
    flow.callback.searchParams.set("error_description", "private detail");
    const res = await request(flow.callback, { headers: { Cookie: flow.cookies } });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).not.toContain("private");
    expect(upstream).not.toHaveBeenCalled();
    expect(codes()).toBe(0);
    expect((await request(flow.callback, { headers: { Cookie: flow.cookies } })).status).toBe(400);
  });
  it("uncertain token exchange is not retried and no auth code is created", async () => {
    upstream.mockRejectedValue(new Error("private upstream error"));
    const flow = await begin("discord");
    const res = await request(flow.callback, { headers: { Cookie: flow.cookies } });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("private");
    await request(flow.callback, { headers: { Cookie: flow.cookies } });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(codes()).toBe(0);
  });
  it("rejects Steam nonce replay across fresh transactions", async () => {
    const nonce = new Date().toISOString().slice(0, 19) + "Zreplay";
    for (let i = 0; i < 2; i++) {
      const flow = await begin("steam");
      flow.callback = steamCallback(flow.auth.searchParams.get("openid.return_to")!, nonce);
      expect((await request(flow.callback, { headers: { Cookie: flow.cookies } })).status).toBe(
        i === 0 ? 302 : 400,
      );
    }
    expect(codes()).toBe(1);
  });
  it.each(["discord", "steam"] as const)(
    "links %s only after authenticated-origin POST intent, retaining verified email",
    async (provider) => {
      existing();
      const intent = await token(provider);
      const flow = await begin(provider, intent);
      expect((await request(flow.callback, { headers: { Cookie: flow.cookies } })).status).toBe(
        302,
      );
      const row = sqlite.prepare("SELECT * FROM users WHERE id=?").get(subject)!;
      expect(row[`${provider}_sub`]).toBe(provider === "discord" ? DISCORD_ID : STEAM_ID);
      expect(row.email).toBe("owner@example.com");
      expect(row.email_verified).toBe(1);
      const params = new URLSearchParams({
        provider,
        redirect_to: `${env.USER_ORIGIN}/auth/callback`,
        state: "fresh",
        link_token: intent,
      });
      expect(
        (
          await request(`${env.IDP_ORIGIN}/auth/login`, {
            method: "POST",
            headers: {
              Origin: env.USER_ORIGIN,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: params,
          })
        ).status,
      ).toBe(400);
    },
  );
  it.each([
    "GET",
    "hostile",
    "null",
    "absent",
    "duplicate",
    "query",
    "wrong-provider",
    "generic-intent",
  ])("rejects transplanted or confused link start: %s", async (variant) => {
    existing();
    const params = new URLSearchParams({
      provider: "discord",
      redirect_to: `${env.USER_ORIGIN}/auth/callback`,
      state: "bff",
      link_token: await token(
        "discord",
        variant === "generic-intent"
          ? { provider: undefined }
          : variant === "wrong-provider"
            ? { provider: "steam" }
            : {},
      ),
    });
    let url = `${env.IDP_ORIGIN}/auth/login`;
    let init: RequestInit = {
      method: "POST",
      headers: { Origin: env.USER_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    };
    if (variant === "GET") {
      url += `?${params.toString()}`;
      init = {};
    }
    if (variant === "hostile" || variant === "null")
      (init.headers as Record<string, string>).Origin =
        variant === "null" ? "null" : "https://evil.example";
    if (variant === "absent") delete (init.headers as Record<string, string>).Origin;
    if (variant === "duplicate") params.append("provider", "steam");
    if (variant === "query") url += "?provider=steam";
    const res = await request(url, init);
    expect(res.status).toBe(400);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(sqlite.prepare("SELECT count(*) AS n FROM social_login_transactions").get()!.n).toBe(0);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects banned link target at callback without linking or code", async () => {
    existing();
    const flow = await begin("discord", await token("discord"));
    sqlite.prepare("UPDATE users SET banned_at='now' WHERE id=?").run(subject);
    expect((await request(flow.callback, { headers: { Cookie: flow.cookies } })).status).toBe(403);
    expect(
      sqlite.prepare("SELECT discord_sub FROM users WHERE id=?").get(subject)!.discord_sub,
    ).toBeNull();
    expect(codes()).toBe(0);
  });
});
