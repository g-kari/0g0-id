import { encodeSession } from "../lib/bff";
import type { BffSession } from "../lib/bff";

const TEST_SESSION_SECRET = "test-secret";

export interface MakeSessionCookieOptions {
  userId?: string;
  email?: string;
  name?: string;
  role?: "user" | "admin";
  sessionId?: string;
  accessToken?: string;
  refreshToken?: string;
  secret?: string;
}

export async function makeSessionCookie(opts: MakeSessionCookieOptions = {}): Promise<string> {
  const session: BffSession = {
    session_id: opts.sessionId ?? "00000000-0000-0000-0000-000000000000",
    access_token: opts.accessToken ?? "mock-access-token",
    refresh_token: opts.refreshToken ?? "mock-refresh-token",
    user: {
      id: opts.userId ?? "user-123",
      email: opts.email ?? "user@example.com",
      name: opts.name ?? "Test User",
      role: opts.role ?? "user",
    },
  };
  return encodeSession(session, opts.secret ?? TEST_SESSION_SECRET);
}
