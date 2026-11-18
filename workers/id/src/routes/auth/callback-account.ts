import type { Context } from "hono";
import type { IdpEnv, OAuthStateCookieData, TokenPayload, User } from "@0g0-id/shared";
import {
  findUserById,
  restErrorBody,
  type OAuthProvider,
  PROVIDER_DISPLAY_NAMES,
} from "@0g0-id/shared";
import type { ProviderResolution } from "../../utils/provider-resolution";
import { handleProviderLink } from "../../utils/auth-helpers";

export type CallbackContext = Context<{ Bindings: IdpEnv; Variables: { user: TokenPayload } }>;

export type CallbackResult<T> = ({ ok: true } & T) | { ok: false; response: Response };

function accountFailure(
  c: CallbackContext,
  status: 403 | 404 | 409,
  code: string,
  message: string,
): CallbackResult<never> {
  return { ok: false, response: c.json(restErrorBody(code, message), status) };
}

function rejectIfSuspended(c: CallbackContext, user: User): CallbackResult<never> | undefined {
  if (user.banned_at !== null) {
    return accountFailure(c, 403, "ACCOUNT_BANNED", "Your account has been suspended");
  }
  return undefined;
}

async function linkProviderToUser(
  c: CallbackContext,
  provider: OAuthProvider,
  providerSub: string,
  linkUserId: string,
): Promise<CallbackResult<{ user: User }>> {
  const linkTargetUser = await findUserById(c.env.DB, linkUserId);
  if (!linkTargetUser) return accountFailure(c, 404, "NOT_FOUND", "User not found");

  const suspendedTarget = rejectIfSuspended(c, linkTargetUser);
  if (suspendedTarget) return suspendedTarget;

  const result = await handleProviderLink(c.env.DB, linkUserId, provider, providerSub);
  if (!result.ok) {
    return accountFailure(
      c,
      409,
      "PROVIDER_ALREADY_LINKED",
      `This ${PROVIDER_DISPLAY_NAMES[provider]} account is already linked to another user`,
    );
  }
  return { ok: true, user: result.user };
}

export async function resolveUserAccount(
  c: CallbackContext,
  provider: OAuthProvider,
  resolved: Extract<ProviderResolution, { ok: true }>,
  stateData: OAuthStateCookieData,
): Promise<CallbackResult<{ user: User }>> {
  // リンク時は使わないが、認可コード ID との発行順を保つため常に先に消費する。
  const userId = crypto.randomUUID();
  const account = stateData.linkUserId
    ? await linkProviderToUser(c, provider, resolved.sub, stateData.linkUserId)
    : { ok: true as const, user: await resolved.upsert(c.env.DB, userId) };
  if (!account.ok) return account;

  const suspended = rejectIfSuspended(c, account.user);
  if (suspended) return suspended;
  return account;
}
