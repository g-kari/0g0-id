import type { IdpEnv } from "@0g0-id/shared";
import { findResourceServerByUri } from "@0g0-id/shared";
import {
  isBffOrigin,
  validateServiceFinalRedirect,
  validateResourceParam,
} from "../../utils/auth-helpers";
import { validateNonce, validateCodeChallengeParams } from "../../utils/scopes";
import type { LoginFinalizationState } from "./finalize";

export interface NativeContinuation {
  finalization: LoginFinalizationState;
  clientId?: string;
  resourceServerId?: string;
}

const LIMITS: Record<string, number> = {
  redirect_to: 2048,
  state: 1024,
  client_id: 128,
  nonce: 128,
  code_challenge: 128,
  code_challenge_method: 16,
  scope: 2048,
  resource: 2048,
};

function bffCallback(env: IdpEnv, redirectTo: string) {
  if (!isBffOrigin(redirectTo, env.USER_ORIGIN, env.ADMIN_ORIGIN, env.EXTRA_BFF_ORIGINS))
    return false;
  const url = new URL(redirectTo);
  return (
    !url.username && !url.password && !url.search && !url.hash && url.pathname === "/auth/callback"
  );
}

/** Validate independently of /authorize and of the BFF; never trust their URL. */
export async function readNativeContinuation(
  url: URL,
  env: IdpEnv,
): Promise<NativeContinuation | null> {
  if (url.search.length > 8192) return null;
  const params: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    if (
      !Object.hasOwn(LIMITS, name) ||
      Object.hasOwn(params, name) ||
      !value ||
      value.length > LIMITS[name] ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      return null;
    params[name] = value;
  }
  const redirectTo = params.redirect_to;
  const bffState = params.state;
  if (
    !redirectTo ||
    !bffState ||
    validateNonce(params.nonce) ||
    validateCodeChallengeParams(params.code_challenge, params.code_challenge_method)
  )
    return null;
  let serviceId: string | undefined;
  if (params.client_id) {
    if (!params.code_challenge) return null; // Every native service login requires PKCE S256.
    // Do not use the 5-minute client cache at an authorization boundary.
    const service = await env.DB.prepare("SELECT id FROM services WHERE client_id = ?")
      .bind(params.client_id)
      .first<{ id: string }>();
    if (!service || !(await validateServiceFinalRedirect(env.DB, service.id, redirectTo)))
      return null;
    serviceId = service.id;
  } else if (!bffCallback(env, redirectTo)) return null;
  let resource: string | undefined;
  let resourceServerId: string | undefined;
  if (params.resource) {
    if (!serviceId) return null;
    const checked = await validateResourceParam(env.DB, params.resource);
    if (!checked.ok) return null;
    resource = checked.uri;
    resourceServerId = checked.resource.id;
  }
  const state: NativeContinuation = {
    finalization: {
      bffState,
      redirectTo,
      provider: "passkey", // A historical method label, NEVER an OAuth provider enum.
      ...(serviceId ? { serviceId } : {}),
      ...(params.nonce ? { nonce: params.nonce } : {}),
      ...(params.code_challenge
        ? { codeChallenge: params.code_challenge, codeChallengeMethod: "S256" }
        : {}),
      ...(params.scope ? { scope: params.scope } : {}),
      ...(resource ? { resource } : {}),
      ...(resourceServerId ? { expectedResourceServerId: resourceServerId } : {}),
    },
    ...(params.client_id ? { clientId: params.client_id } : {}),
    ...(resourceServerId ? { resourceServerId } : {}),
  };
  // Leave room for browser binding, CSRF, purpose/expiry and AEAD overhead.
  // Fail closed rather than silently truncating an OAuth parameter or a cookie.
  return new TextEncoder().encode(JSON.stringify(state)).length <= 1700 ? state : null;
}

/** Service and resource deletion/re-registration cannot resurrect an old flow. */
export async function nativeContinuationIsCurrent(
  env: IdpEnv,
  continuation: NativeContinuation,
): Promise<boolean> {
  const state = continuation.finalization;
  if (state.serviceId) {
    const current = await env.DB.prepare("SELECT id FROM services WHERE id = ? AND client_id = ?")
      .bind(state.serviceId, continuation.clientId ?? "")
      .first<{ id: string }>();
    if (!current || !(await validateServiceFinalRedirect(env.DB, current.id, state.redirectTo)))
      return false;
  } else if (!bffCallback(env, state.redirectTo)) return false;
  if (state.resource) {
    const current = await findResourceServerByUri(env.DB, state.resource);
    if (!current || current.id !== continuation.resourceServerId) return false;
  }
  return true;
}
