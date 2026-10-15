import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Hono } from "hono";
import type { BffEnv } from "../types";
import { createBffDbscRoutes } from "./bff-dbsc-factory";
import { requireDbscBoundSession } from "../middleware/require-dbsc-bound";
import { parseSession, internalServiceHeaders } from "./bff";
import { verifyDbscRegistrationJwt } from "./dbsc";

vi.mock("./bff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bff")>()),
  parseSession: vi.fn(),
  internalServiceHeaders: vi.fn(),
}));
vi.mock("./dbsc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dbsc")>()),
  verifyDbscRegistrationJwt: vi.fn(),
}));

const CANARY = "synthetic-private-bff-person@example.invalid";
const config = {
  sessionCookieName: "__Host-test-session",
  loggerName: "test-dbsc-status",
  credentialsCookieName: "__Host-test-cred",
};
const cases = [
  {
    name: "bind",
    path: "/auth/dbsc/start",
    msg: "[dbsc-start] IdP bind failed",
    body: "h.p.s",
    proof: false,
  },
  {
    name: "challenge",
    path: "/auth/dbsc/refresh",
    msg: "[dbsc-refresh] challenge issue failed",
    body: undefined,
    proof: false,
  },
  {
    name: "verify",
    path: "/auth/dbsc/refresh",
    msg: "[dbsc-refresh] verify failed",
    body: undefined,
    proof: true,
  },
  {
    name: "status lookup",
    path: `/api/${CANARY}`,
    msg: "[require-dbsc-bound] status lookup failed",
    body: undefined,
    proof: false,
  },
] as const;

describe("BFF status capability with the actual logger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(parseSession).mockResolvedValue({
      session_id: CANARY,
      access_token: CANARY,
      refresh_token: CANARY,
      user: { id: CANARY, email: CANARY, name: CANARY, role: "user" },
    });
    vi.mocked(internalServiceHeaders).mockReturnValue({});
    vi.mocked(verifyDbscRegistrationJwt).mockResolvedValue({
      publicJwk: { kty: "EC" },
      claims: {},
    } as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(cases)("$name", (testCase) => {
    it.each([403, 503])(
      "preserves only upstream status %d and the existing response",
      async (status) => {
        const upstream = new Response(CANARY, { status });
        const reader = vi.spyOn(upstream, "text");
        const fetch = vi.fn().mockResolvedValueOnce(upstream);
        const app = new Hono<{ Bindings: BffEnv }>();
        app.route("/auth/dbsc", createBffDbscRoutes(config));
        app.use("/api/*", requireDbscBoundSession({ ...config, enforce: true }));
        app.post("/api/:id", (c) => c.json({ ok: true }));
        const env = {
          IDP: { fetch },
          IDP_ORIGIN: "https://id.example.invalid",
          SELF_ORIGIN: "https://user.example.invalid",
          SESSION_SECRET: "synthetic-unused-session-secret",
        } as unknown as BffEnv;
        const res = await app.request(
          `https://user.example.invalid${testCase.path}?private=${CANARY}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/jwt",
              ...(testCase.proof ? { "Sec-Session-Response": "h.p.s" } : {}),
            },
            body: testCase.body,
          },
          env,
        );
        expect(res.status).toBe(
          testCase.name === "status lookup" ? 200 : status >= 500 ? 500 : 400,
        );
        expect(console.warn).toHaveBeenCalledExactlyOnceWith(
          JSON.stringify({
            level: "warn",
            ctx: config.loggerName,
            msg: testCase.msg,
            data: { status },
          }),
        );
        expect(console.error).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalled();
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(CANARY);
        expect(reader).not.toHaveBeenCalled();
        expect(upstream.bodyUsed).toBe(false);
        expect(fetch).toHaveBeenCalledOnce();
      },
    );
  });
});
