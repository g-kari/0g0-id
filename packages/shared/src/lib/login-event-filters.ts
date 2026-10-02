import { isValidProvider, type OAuthProvider } from "./providers";

export type LoginEventPeriod = "all" | "24h" | "7d" | "30d";

export interface LoginEventFilters {
  userId?: string;
  country?: string;
  provider?: OAuthProvider;
  sinceIso?: string;
}

export interface LoginEventQuery {
  limit: number;
  offset: number;
  userId?: string;
  country?: string;
  provider?: OAuthProvider;
  period: LoginEventPeriod;
}

const ALLOWED_KEYS = new Set(["limit", "offset", "user_id", "country", "provider", "period"]);

/** Reject malformed/ambiguous filters so a typo cannot silently broaden an investigation. */
export function parseLoginEventQuery(params: URLSearchParams): LoginEventQuery | { error: string } {
  if (params.toString().length > 2048) return { error: "query must be at most 2048 characters" };
  for (const key of params.keys()) {
    if (!ALLOWED_KEYS.has(key)) return { error: "unknown query parameter" };
    if (params.getAll(key).length !== 1) return { error: "query parameters must not be repeated" };
  }

  const limitRaw = params.get("limit");
  const offsetRaw = params.get("offset");
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (
    (limitRaw !== null && !/^\d{1,3}$/.test(limitRaw)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    return { error: "limit must be an integer between 1 and 100" };
  if (
    (offsetRaw !== null && !/^\d{1,16}$/.test(offsetRaw)) ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    return { error: "offset must be a non-negative safe integer" };

  const userId = params.get("user_id") ?? undefined;
  if (userId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
    return { error: "user_id must be 1 to 128 letters, digits, underscores or hyphens" };
  }
  const country = params.get("country") ?? undefined;
  if (country !== undefined && country !== "unknown" && !/^[A-Z]{2}$/.test(country)) {
    return { error: "country must be an uppercase two-letter code or unknown" };
  }
  const provider = params.get("provider") ?? undefined;
  if (provider !== undefined && !isValidProvider(provider)) {
    return { error: "provider must be a supported OAuth provider" };
  }
  const period = params.get("period") ?? "all";
  if (period !== "all" && period !== "24h" && period !== "7d" && period !== "30d") {
    return { error: "period must be all, 24h, 7d or 30d" };
  }
  return { limit, offset, userId, country, provider, period };
}

/** Resolve the cutoff once per request, shared by SELECT and COUNT. */
export function loginEventFilters(query: LoginEventQuery, now = Date.now()): LoginEventFilters {
  const days = query.period === "24h" ? 1 : query.period === "7d" ? 7 : 30;
  return {
    userId: query.userId,
    country: query.country,
    provider: query.provider,
    sinceIso: query.period === "all" ? undefined : new Date(now - days * 86400000).toISOString(),
  };
}
