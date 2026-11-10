import { readProviderResponse, requireProviderCallback } from "./provider-http";

const AUTH_URL = "https://discord.com/oauth2/authorize";
const TOKEN_URL = "https://discord.com/api/oauth2/token";
const USER_URL = "https://discord.com/api/v10/users/@me";
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE = /^[A-Za-z0-9_-]{22,128}$/;
const SNOWFLAKE = /^[1-9][0-9]{0,19}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SNOWFLAKE.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
  );
}

/** Login requires only identify. No email, bot, guild, friends or offline scope. */
export function buildDiscordAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  try {
    const callback = requireProviderCallback(params.redirectUri);
    if (
      callback.search ||
      !validId(params.clientId) ||
      !STATE.test(params.state) ||
      !PKCE_CHALLENGE.test(params.codeChallenge)
    )
      throw new Error();
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      scope: "identify",
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  } catch {
    throw new Error("Invalid Discord authorization parameters");
  }
}

/** Single attempt: an ambiguous exchange outcome must restart authorization, not replay the code. */
export async function exchangeDiscordCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ access_token: string }> {
  try {
    const callback = requireProviderCallback(params.redirectUri);
    if (
      callback.search ||
      !validId(params.clientId) ||
      !params.clientSecret ||
      !params.code ||
      params.code.length > 2048 ||
      !PKCE_VERIFIER.test(params.codeVerifier)
    )
      throw new Error();
    const text = await readProviderResponse(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: params.code,
        client_id: params.clientId,
        client_secret: params.clientSecret,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
      }).toString(),
    });
    const data: unknown = JSON.parse(text);
    if (
      !isRecord(data) ||
      "error" in data ||
      typeof data.access_token !== "string" ||
      !/^[\x21-\x7e]{1,4096}$/.test(data.access_token) ||
      typeof data.token_type !== "string" ||
      data.token_type.toLowerCase() !== "bearer" ||
      data.scope !== "identify"
    )
      throw new Error();
    // Deliberately discard refresh tokens and all other fields.
    return { access_token: data.access_token };
  } catch {
    throw new Error("Discord token exchange failed");
  }
}

export interface DiscordIdentity {
  id: string;
  name: string;
  picture: string | null;
}

/** Return only display identity; provider email is neither requested nor trusted. */
export async function fetchDiscordUserInfo(accessToken: string): Promise<DiscordIdentity> {
  try {
    if (!/^[\x21-\x7e]{1,4096}$/.test(accessToken)) throw new Error();
    const text = await readProviderResponse(USER_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    const data: unknown = JSON.parse(text);
    if (!isRecord(data) || !validId(data.id)) throw new Error();
    const name = data.global_name ?? data.username;
    if (typeof name !== "string" || name.length < 1 || name.length > 128) throw new Error();
    const avatar = data.avatar;
    if (avatar != null && (typeof avatar !== "string" || !/^(a_)?[a-f0-9]{32}$/.test(avatar))) {
      throw new Error();
    }
    return {
      id: data.id,
      name,
      picture: avatar ? `https://cdn.discordapp.com/avatars/${data.id}/${avatar}.png` : null,
    };
  } catch {
    throw new Error("Discord user info fetch failed");
  }
}
