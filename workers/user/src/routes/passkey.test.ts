import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import type { BffEnv } from "@0g0-id/shared";
import { COOKIE_NAMES } from "@0g0-id/shared";
import passkeyRoutes from "./passkey";
import oauthRoutes from "./oauth";

const env = {
  IDP_ORIGIN: "https://id.example.test",
  SELF_ORIGIN: "https://user.example.test",
} as BffEnv;
function app() {
  return new Hono().route("/auth", passkeyRoutes).route("/", oauthRoutes);
}
describe("separate BFF passkey entry", () => {
  it.each([undefined, "false", "1"])(
    "hides email signup unless its own literal flag is enabled (%s)",
    async (flag) => {
      const bindings = {
        ...env,
        PASSKEY_LOGIN_ENABLED: "true",
        EMAIL_PASSKEY_SIGNUP_ENABLED: flag,
      };
      expect((await app().request("/auth/signup", {}, bindings)).status).toBe(404);
      const status = await app().request("/auth/signup/status", {}, bindings);
      expect(await status.json()).toEqual({ enabled: false });
      expect(status.headers.get("Cache-Control")).toBe("no-store");
    },
  );
  it("routes signup through fixed IdP and BFF callback, ignoring caller query overrides", async () => {
    const bindings = { ...env, EMAIL_PASSKEY_SIGNUP_ENABLED: "true" };
    expect(await (await app().request("/auth/signup/status", {}, bindings)).json()).toEqual({
      enabled: true,
    });
    const response = await app().request(
      "/auth/signup?redirect_to=https://evil.test&state=attacker&provider=google",
      {},
      bindings,
    );
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("Location")!);
    expect(target.origin + target.pathname).toBe("https://id.example.test/auth/email/signup/start");
    expect(target.searchParams.get("redirect_to")).toBe("https://user.example.test/auth/callback");
    expect(target.searchParams.get("provider")).toBeNull();
    expect(target.searchParams.get("state")).not.toBe("attacker");
    expect(response.headers.get("Set-Cookie")).toContain(
      `${COOKIE_NAMES.USER_STATE}=${target.searchParams.get("state")!}`,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("offers signup separately while preserving the service authorization continuation", async () => {
    const query = new URLSearchParams({
      client_id: "client-1",
      redirect_uri: "https://client.example.test/callback",
      state: "state-1",
      code_challenge: "A".repeat(43),
      nonce: "nonce-1",
      resource: "https://api.example.test/",
      scope: "openid",
    }).toString();
    expect(await (await app().request(`/login?${query}`, {}, env)).text()).not.toContain(
      "/auth/email/signup/start",
    );
    const html = await (
      await app().request(`/login?${query}`, {}, { ...env, EMAIL_PASSKEY_SIGNUP_ENABLED: "true" })
    ).text();
    const target = new URL(
      html
        .match(/href="(https:\/\/id.example.test\/auth\/email\/signup\/start[^"]+)"/)![1]
        .replaceAll("&amp;", "&"),
    );
    expect(target.searchParams.get("provider")).toBeNull();
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    for (const [key, value] of new URLSearchParams(query)) {
      expect(target.searchParams.get(key === "redirect_uri" ? "redirect_to" : key)).toBe(value);
    }
  });
  it("is hidden and disabled by default", async () => {
    expect((await app().request("/auth/passkey", {}, env)).status).toBe(404);
    const status = await app().request("/auth/passkey/status", {}, env);
    expect(await status.json()).toEqual({ enabled: false });
    expect(status.headers.get("Cache-Control")).toBe("no-store");
  });
  it("sets the usual BFF state cookie and routes to IdP, without claiming an OAuth provider", async () => {
    const response = await app().request(
      "/auth/passkey?state=attacker&redirect_to=https://evil.test&provider=google",
      {},
      { ...env, PASSKEY_LOGIN_ENABLED: "true" },
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe("https://id.example.test/auth/passkey/start");
    expect(location.searchParams.get("redirect_to")).toBe(
      "https://user.example.test/auth/callback",
    );
    expect(location.searchParams.get("provider")).toBeNull();
    expect(location.searchParams.get("state")).not.toBe("attacker");
    expect(response.headers.get("Set-Cookie")).toContain(
      `${COOKIE_NAMES.USER_STATE}=${location.searchParams.get("state")!}`,
    );
  });
  it("offers a distinct optional service login, carrying PKCE, nonce and resource", async () => {
    const query = new URLSearchParams({
      client_id: "client-1",
      redirect_uri: "https://client.example.test/callback",
      state: "state-1",
      code_challenge: "A".repeat(43),
      nonce: "nonce-1",
      resource: "https://api.example.test/",
      scope: "openid",
    }).toString();
    const disabled = await app().request(`/login?${query}`, {}, env);
    expect(await disabled.text()).not.toContain("/auth/passkey/start");
    const enabled = await app().request(
      `/login?${query}`,
      {},
      { ...env, PASSKEY_LOGIN_ENABLED: "true" },
    );
    const html = await enabled.text();
    const href = html
      .match(/href="(https:\/\/id.example.test\/auth\/passkey\/start[^"]+)"/)![1]
      .replaceAll("&amp;", "&");
    const target = new URL(href);
    expect(target.searchParams.get("provider")).toBeNull();
    expect(target.searchParams.get("nonce")).toBe("nonce-1");
    expect(target.searchParams.get("code_challenge")).toBe("A".repeat(43));
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("resource")).toBe("https://api.example.test/");
    expect(target.searchParams.get("state")).toBe("state-1");
    expect(target.searchParams.get("client_id")).toBe("client-1");
  });
});
