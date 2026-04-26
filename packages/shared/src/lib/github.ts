import { z } from "zod";
import { fetchWithRetry } from "./fetch-retry";
import { createLogger } from "./logger";

const logger = createLogger("oauth-github");

const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

const GithubUserInfoSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
});

export type GithubUserInfo = z.infer<typeof GithubUserInfoSchema>;

export interface GithubEmailInfo {
  email: string;
  primary: boolean;
  verified: boolean;
}

export interface GithubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

/**
 * GitHub認可URLを生成する（PKCE S256対応）
 */
export function buildGithubAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(GITHUB_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * GitHubトークンエンドポイントを呼び出してアクセストークンを取得する
 */
export async function exchangeGithubCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<GithubTokenResponse> {
  const response = await fetchWithRetry(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    logger.error(`GitHub token exchange failed (${response.status})`, error);
    throw new Error("GitHub token exchange failed");
  }

  try {
    const data = (await response.json()) as GithubTokenResponse & { error?: string };
    if (data.error) {
      logger.error("GitHub token exchange failed", data.error);
      throw new Error("GitHub token exchange failed");
    }
    return data;
  } catch (e) {
    if (e instanceof Error && e.message === "GitHub token exchange failed") throw e;
    throw new Error("GitHub token exchange failed: Invalid JSON response");
  }
}

/**
 * GitHub User APIを呼び出してユーザー情報を取得する
 */
export async function fetchGithubUserInfo(accessToken: string): Promise<GithubUserInfo> {
  const response = await fetchWithRetry(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "0g0-id",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub user info fetch failed: ${response.status}`);
  }

  try {
    return GithubUserInfoSchema.parse(await response.json());
  } catch {
    throw new Error("GitHub user info fetch failed: Invalid JSON response");
  }
}

/**
 * GitHub Emails APIを呼び出してプライマリメールアドレスを取得する
 */
export async function fetchGithubPrimaryEmail(accessToken: string): Promise<string | null> {
  const response = await fetchWithRetry(GITHUB_EMAILS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "0g0-id",
    },
  });

  if (!response.ok) {
    // API失敗は「メールなし」とは異なるため、throwして呼び出し元に判断を委ねる
    throw new Error(`GitHub Emails API failed with status ${response.status}`);
  }

  try {
    const emails = (await response.json()) as GithubEmailInfo[];
    const primary = emails.find((e) => e.primary && e.verified);
    return primary?.email ?? null;
  } catch {
    throw new Error("GitHub Emails API returned invalid JSON");
  }
}
