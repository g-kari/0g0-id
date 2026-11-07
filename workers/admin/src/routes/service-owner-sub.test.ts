import { describe, expect, it, vi } from "vite-plus/test";
import { encodeSession } from "@0g0-id/shared";
import app from "../index";

const ID = "a0000000-0000-0000-0000-000000000001";
const SECRET = "synthetic-session-secret-at-least-32-chars";
const data = {
  service_id: ID,
  client_id: "synthetic-client",
  owner_user_id: ID,
  sub: "a".repeat(64),
};

async function request(
  options: {
    role?: "admin" | "user";
    noSession?: boolean;
    status?: number;
    query?: string;
    id?: string;
    networkError?: boolean;
  } = {},
): Promise<{ res: Response; upstream: ReturnType<typeof vi.fn> }> {
  const cookie = await encodeSession(
    {
      session_id: ID,
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      user: {
        id: ID,
        email: "synthetic@example.invalid",
        name: "Synthetic",
        role: options.role ?? "admin",
      },
    },
    SECRET,
  );
  const upstream = options.networkError
    ? vi.fn().mockRejectedValue(new Error("SYNTHETIC-PRIVATE-ERROR"))
    : vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(options.status ? { error: { code: "SYNTHETIC_ERROR" } } : { data }),
          {
            status: options.status ?? 200,
            headers: { "Content-Type": "application/json", "Cache-Control": "public" },
          },
        ),
      );
  const res = await app.request(
    `https://admin.0g0.xyz/api/services/${options.id ?? ID}/owner-sub${options.query ?? ""}`,
    {
      headers: options.noSession ? {} : { Cookie: `__Host-admin-session=${cookie}` },
    },
    {
      IDP: { fetch: upstream } as unknown as Fetcher,
      IDP_ORIGIN: "https://id.0g0.xyz",
      SELF_ORIGIN: "https://admin.0g0.xyz",
      SESSION_SECRET: SECRET,
      ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
      RATE_LIMITER_ADMIN_API: { limit: async () => ({ success: true }) },
    },
  );
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return { res, upstream };
}

describe("admin owner subject BFF (real application middleware)", () => {
  it("401 without session", async () => {
    const { res, upstream } = await request({ noSession: true });
    expect(res.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("403 for non-admin", async () => {
    const { res, upstream } = await request({ role: "user" });
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("400 for invalid UUID", async () => {
    const { res, upstream } = await request({ id: "invalid" });
    expect(res.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(["?user_id=other", "?client_id=other", "?sub=other"])(
    "400 rejects %s without forwarding",
    async (query) => {
      const { res, upstream } = await request({ query });
      expect(res.status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
    },
  );
  it("forwards only a fixed GET using the admin session", async () => {
    const { res, upstream } = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data });
    expect(upstream).toHaveBeenCalledOnce();
    const sent = upstream.mock.calls[0][0] as Request;
    expect(sent.url).toBe(`https://id.0g0.xyz/api/services/${ID}/owner-sub`);
    expect(sent.method).toBe("GET");
    expect(sent.body).toBeNull();
    expect(sent.headers.get("Authorization")).toBe("Bearer synthetic-access");
    expect(sent.headers.get("X-BFF-Session-Id")).toBe(ID);
  });
  it.each([403, 404, 500])("propagates upstream %s", async (status) => {
    const { res } = await request({ status });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: { code: "SYNTHETIC_ERROR" } });
  });
  it("502 for network failure without exception contents", async () => {
    const { res } = await request({ networkError: true });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("SYNTHETIC-PRIVATE-ERROR");
  });
});
