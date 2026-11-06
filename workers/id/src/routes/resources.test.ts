import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { Hono } from "hono";
import { createMockIdpEnv } from "../../../../packages/shared/src/db/test-helpers";

// --- モック定義 ---
vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    createLogger: vi
      .fn()
      .mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    listResourceServers: vi.fn(),
    findResourceServerById: vi.fn(),
    findResourceServerByUri: vi.fn(),
    createResourceServer: vi.fn(),
    updateResourceServer: vi.fn(),
    deleteResourceServerWithTokenRevocation: vi.fn(),
  };
});

vi.mock("../middleware/auth", () => ({
  authMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { sub: "admin-1" });
    await next();
  },
}));

vi.mock("../middleware/admin", () => ({
  adminMiddleware: async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

vi.mock("../middleware/csrf", () => ({
  csrfMiddleware: async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

vi.mock("../lib/audit", () => ({
  logAdminAudit: vi.fn(),
}));

import {
  findResourceServerById,
  findResourceServerByUri,
  createResourceServer,
  updateResourceServer,
  deleteResourceServerWithTokenRevocation,
} from "@0g0-id/shared";
import resourcesRoutes from "./resources";

// --- テスト用定数 ---
const mockEnv = createMockIdpEnv();
const RESOURCE_URI = "https://dots-events.0g0.xyz/mcp";

const mockResource = {
  id: "rs-1",
  uri: RESOURCE_URI,
  name: "dots-events",
  allowed_scopes: '["events:read","events:subscribe"]',
  allowed_subjects: "[]",
  owner_user_id: "admin-1",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

function buildApp() {
  const app = new Hono<{ Bindings: typeof mockEnv }>();
  app.route("/api/resources", resourcesRoutes);
  return app;
}

function request(method: string, path: string, body?: Record<string, unknown>) {
  const app = buildApp();
  return app.request(
    new Request(`https://id.0g0.xyz${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
    undefined,
    mockEnv,
  );
}

describe("/api/resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findResourceServerByUri).mockResolvedValue(null);
  });

  describe("POST /", () => {
    it("allowed_subjects を指定して作成できる", async () => {
      vi.mocked(createResourceServer).mockResolvedValue({
        ...mockResource,
        allowed_subjects: '["user-1"]',
      });

      const res = await request("POST", "/api/resources", {
        uri: RESOURCE_URI,
        name: "dots-events",
        allowed_scopes: ["events:read", "events:subscribe"],
        allowed_subjects: ["user-1"],
      });

      expect(res.status).toBe(201);
      expect(createResourceServer).toHaveBeenCalledWith(
        mockEnv.DB,
        expect.objectContaining({ allowedSubjects: '["user-1"]' }),
      );
      const body = await res.json<{ data: { allowed_subjects: string } }>();
      expect(body.data.allowed_subjects).toBe('["user-1"]');
    });

    it("allowed_subjects 省略時は制限なし（[]）で作成する", async () => {
      vi.mocked(createResourceServer).mockResolvedValue(mockResource);

      const res = await request("POST", "/api/resources", {
        uri: RESOURCE_URI,
        name: "dots-events",
        allowed_scopes: ["events:read"],
      });

      expect(res.status).toBe(201);
      expect(createResourceServer).toHaveBeenCalledWith(
        mockEnv.DB,
        expect.objectContaining({ allowedSubjects: "[]" }),
      );
    });
  });

  describe("PUT /:id", () => {
    it("allowed_subjects を更新できる", async () => {
      vi.mocked(findResourceServerById).mockResolvedValue(mockResource);
      vi.mocked(updateResourceServer).mockResolvedValue({
        ...mockResource,
        allowed_subjects: '["user-1","user-2"]',
      });

      const res = await request("PUT", "/api/resources/rs-1", {
        name: "dots-events",
        allowed_scopes: ["events:read"],
        allowed_subjects: ["user-1", "user-2"],
      });

      expect(res.status).toBe(200);
      expect(updateResourceServer).toHaveBeenCalledWith(
        mockEnv.DB,
        "rs-1",
        expect.objectContaining({ allowedSubjects: '["user-1","user-2"]' }),
      );
    });
  });

  describe("DELETE /:id", () => {
    it("削除時にその resource の refresh token を全て失効させる", async () => {
      vi.mocked(findResourceServerById).mockResolvedValue(mockResource);
      vi.mocked(deleteResourceServerWithTokenRevocation).mockResolvedValue(3);

      const res = await request("DELETE", "/api/resources/rs-1");

      expect(res.status).toBe(204);
      // 失効と削除は単一の原子的ヘルパーで実行される（競合防止）
      expect(deleteResourceServerWithTokenRevocation).toHaveBeenCalledWith(
        mockEnv.DB,
        mockResource,
      );
    });

    it("存在しない resource → 404（失効も削除もしない）", async () => {
      vi.mocked(findResourceServerById).mockResolvedValue(null);

      const res = await request("DELETE", "/api/resources/rs-unknown");

      expect(res.status).toBe(404);
      expect(deleteResourceServerWithTokenRevocation).not.toHaveBeenCalled();
    });
  });
});
