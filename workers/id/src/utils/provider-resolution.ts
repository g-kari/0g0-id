import { type Context } from "hono";
import {
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  exchangeLineCode,
  fetchLineUserInfo,
  exchangeTwitchCode,
  fetchTwitchUserInfo,
  exchangeGithubCode,
  fetchGithubUserInfo,
  fetchGithubPrimaryEmail,
  exchangeXCode,
  fetchXUserInfo,
  upsertUser,
  upsertLineUser,
  upsertTwitchUser,
  upsertGithubUser,
  upsertXUser,
  createLogger,
} from "@0g0-id/shared";
import type { IdpEnv, TokenPayload, User } from "@0g0-id/shared";
import type { OAuthProvider } from "@0g0-id/shared";

type Variables = { user: TokenPayload };

const providerLogger = createLogger("auth");

/** プロバイダー認証の解決結果 */
export type ProviderResolution =
  | { ok: true; sub: string; upsert: (db: D1Database, id: string) => Promise<User> }
  | { ok: false; response: Response };

function oauthError(
  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
  message: string,
  code: string = "OAUTH_ERROR",
): { ok: false; response: Response } {
  return { ok: false, response: c.json({ error: { code, message } }, 400) };
}

/**
 * OAuthプロバイダー共通のコード交換・ユーザー情報取得処理。
 * 各 resolve*Provider 関数の try/catch ボイラープレートを集約する。
 */
async function exchangeAndFetchUserInfo<TTokenResponse extends { access_token: string }, TUserInfo>(
  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
  providerKey: string,
  displayName: string,
  exchangeFn: () => Promise<TTokenResponse>,
  fetchFn: (accessToken: string) => Promise<TUserInfo>,
): Promise<
  | { ok: true; tokenResponse: TTokenResponse; userInfo: TUserInfo }
  | { ok: false; response: Response }
> {
  let tokens: TTokenResponse;
  try {
    tokens = await exchangeFn();
  } catch (err) {
    providerLogger.error(`[oauth-${providerKey}] Failed to exchange code`, err);
    return oauthError(c, `Failed to exchange ${displayName} code`);
  }

  let userInfo: TUserInfo;
  try {
    userInfo = await fetchFn(tokens.access_token);
  } catch (err) {
    providerLogger.error(`[oauth-${providerKey}] Failed to fetch user info`, err);
    return oauthError(c, `Failed to fetch ${displayName} user info`);
  }

  return { ok: true, tokenResponse: tokens, userInfo };
}

function makePlaceholderEmail(
  provider: string,
  sub: string,
  rawEmail?: string | null,
): { email: string; isPlaceholderEmail: boolean } {
  return {
    email: rawEmail || `${provider}_${sub}@${provider}.placeholder`,
    isPlaceholderEmail: !rawEmail,
  };
}

/** OAuthプロバイダーのコード交換・ユーザー情報取得・upsert関数を一元化 */
export async function resolveProvider(
  c: Context<{ Bindings: IdpEnv; Variables: Variables }>,
  provider: OAuthProvider,
  code: string,
  pkceVerifier: string,
  callbackUri: string,
): Promise<ProviderResolution> {
  switch (provider) {
    case "google": {
      const result = await exchangeAndFetchUserInfo(
        c,
        "google",
        "Google",
        () =>
          exchangeGoogleCode({
            code,
            clientId: c.env.GOOGLE_CLIENT_ID,
            clientSecret: c.env.GOOGLE_CLIENT_SECRET,
            redirectUri: callbackUri,
            codeVerifier: pkceVerifier,
          }),
        fetchGoogleUserInfo,
      );
      if (!result.ok) return result;
      const { userInfo } = result;
      if (!userInfo.email_verified) {
        return oauthError(c, "Email not verified", "UNVERIFIED_EMAIL");
      }
      return {
        ok: true,
        sub: userInfo.sub,
        upsert: (db, id) =>
          upsertUser(db, {
            id,
            googleSub: userInfo.sub,
            email: userInfo.email,
            emailVerified: userInfo.email_verified,
            name: userInfo.name,
            picture: userInfo.picture ?? null,
          }),
      };
    }

    case "line": {
      const result = await exchangeAndFetchUserInfo(
        c,
        "line",
        "LINE",
        () =>
          exchangeLineCode({
            code,
            clientId: c.env.LINE_CLIENT_ID!,
            clientSecret: c.env.LINE_CLIENT_SECRET!,
            redirectUri: callbackUri,
            codeVerifier: pkceVerifier,
          }),
        fetchLineUserInfo,
      );
      if (!result.ok) return result;
      const { userInfo } = result;
      const { email, isPlaceholderEmail } = makePlaceholderEmail(
        "line",
        userInfo.sub,
        userInfo.email,
      );
      return {
        ok: true,
        sub: userInfo.sub,
        upsert: (db, id) =>
          upsertLineUser(db, {
            id,
            lineSub: userInfo.sub,
            email,
            isPlaceholderEmail,
            name: userInfo.name,
            picture: userInfo.picture ?? null,
          }),
      };
    }

    case "twitch": {
      const result = await exchangeAndFetchUserInfo(
        c,
        "twitch",
        "Twitch",
        () =>
          exchangeTwitchCode({
            code,
            clientId: c.env.TWITCH_CLIENT_ID!,
            clientSecret: c.env.TWITCH_CLIENT_SECRET!,
            redirectUri: callbackUri,
            codeVerifier: pkceVerifier,
          }),
        fetchTwitchUserInfo,
      );
      if (!result.ok) return result;
      const { userInfo } = result;
      const { email, isPlaceholderEmail } = makePlaceholderEmail(
        "twitch",
        userInfo.sub,
        userInfo.email,
      );
      if (!isPlaceholderEmail && !(userInfo.email_verified ?? false)) {
        return oauthError(c, "Email not verified", "UNVERIFIED_EMAIL");
      }
      return {
        ok: true,
        sub: userInfo.sub,
        upsert: (db, id) =>
          upsertTwitchUser(db, {
            id,
            twitchSub: userInfo.sub,
            email,
            isPlaceholderEmail,
            emailVerified: userInfo.email_verified ?? false,
            name: userInfo.preferred_username,
            picture: userInfo.picture ?? null,
          }),
      };
    }

    case "github": {
      const result = await exchangeAndFetchUserInfo(
        c,
        "github",
        "GitHub",
        () =>
          exchangeGithubCode({
            code,
            clientId: c.env.GITHUB_CLIENT_ID!,
            clientSecret: c.env.GITHUB_CLIENT_SECRET!,
            redirectUri: callbackUri,
            codeVerifier: pkceVerifier,
          }),
        fetchGithubUserInfo,
      );
      if (!result.ok) return result;
      const { tokenResponse, userInfo: githubUser } = result;
      const githubSub = String(githubUser.id);
      // GitHub User APIのemailフィールドは検証済みとは限らないため、
      // 常にEmails APIから検証済みプライマリメールを取得する
      let email: string | null;
      try {
        email = await fetchGithubPrimaryEmail(tokenResponse.access_token);
      } catch (err) {
        providerLogger.error("[oauth-github] Failed to fetch primary email", err);
        return oauthError(c, "Failed to fetch GitHub email");
      }
      const { email: finalEmail, isPlaceholderEmail } = makePlaceholderEmail(
        "github",
        githubSub,
        email,
      );
      return {
        ok: true,
        sub: githubSub,
        upsert: (db, id) =>
          upsertGithubUser(db, {
            id,
            githubSub,
            email: finalEmail,
            isPlaceholderEmail,
            name: githubUser.name ?? githubUser.login,
            picture: githubUser.avatar_url,
          }),
      };
    }

    case "x": {
      const result = await exchangeAndFetchUserInfo(
        c,
        "x",
        "X",
        () =>
          exchangeXCode({
            code,
            clientId: c.env.X_CLIENT_ID!,
            clientSecret: c.env.X_CLIENT_SECRET!,
            redirectUri: callbackUri,
            codeVerifier: pkceVerifier,
          }),
        fetchXUserInfo,
      );
      if (!result.ok) return result;
      const { userInfo: xUser } = result;
      const { email: xEmail } = makePlaceholderEmail("x", xUser.id);
      return {
        ok: true,
        sub: xUser.id,
        upsert: (db, id) =>
          upsertXUser(db, {
            id,
            xSub: xUser.id,
            email: xEmail,
            isPlaceholderEmail: true,
            name: xUser.name ?? xUser.username,
            picture: xUser.profile_image_url ?? null,
          }),
      };
    }
  }
}
