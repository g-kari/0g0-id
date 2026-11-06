import { describe, it, expect } from "vite-plus/test";
import {
  findResourceServerById,
  findResourceServerByUri,
  listResourceServers,
  createResourceServer,
  updateResourceServer,
  deleteResourceServer,
} from "./resource-servers";
import type { ResourceServer } from "../types";
import { makeD1Mock } from "./test-helpers";

const baseResource: ResourceServer = {
  id: "rs-1",
  uri: "https://dots-events.0g0.xyz/mcp",
  name: "dots-events",
  allowed_scopes: '["events:read","events:subscribe"]',
  allowed_subjects: "[]",
  owner_user_id: "user-1",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

describe("findResourceServerByUri", () => {
  it("URIでリソースサーバーを取得できる", async () => {
    const db = makeD1Mock(baseResource);
    const result = await findResourceServerByUri(db, "https://dots-events.0g0.xyz/mcp");
    expect(result).toEqual(baseResource);
    expect(db.prepare).toHaveBeenCalledWith("SELECT * FROM resource_servers WHERE uri = ?");
  });

  it("未登録のURIはnullを返す", async () => {
    const db = makeD1Mock(null);
    const result = await findResourceServerByUri(db, "https://unknown.example/mcp");
    expect(result).toBeNull();
  });
});

describe("findResourceServerById", () => {
  it("IDでリソースサーバーを取得できる", async () => {
    const db = makeD1Mock(baseResource);
    const result = await findResourceServerById(db, "rs-1");
    expect(result).toEqual(baseResource);
  });
});

describe("listResourceServers", () => {
  it("全件を返す", async () => {
    const db = makeD1Mock(null, [baseResource]);
    const result = await listResourceServers(db);
    expect(result).toEqual([baseResource]);
  });
});

describe("createResourceServer", () => {
  it("作成して返す", async () => {
    const db = makeD1Mock(baseResource);
    const result = await createResourceServer(db, {
      id: "rs-1",
      uri: "https://dots-events.0g0.xyz/mcp",
      name: "dots-events",
      allowedScopes: '["events:read","events:subscribe"]',
      ownerUserId: "user-1",
    });
    expect(result).toEqual(baseResource);
  });

  it("allowedSubjects を指定すると INSERT に含まれる", async () => {
    const restricted: ResourceServer = { ...baseResource, allowed_subjects: '["user-1"]' };
    const db = makeD1Mock(restricted);
    const result = await createResourceServer(db, {
      id: "rs-1",
      uri: "https://dots-events.0g0.xyz/mcp",
      name: "dots-events",
      allowedScopes: '["events:read","events:subscribe"]',
      allowedSubjects: '["user-1"]',
      ownerUserId: "user-1",
    });
    expect(result.allowed_subjects).toBe('["user-1"]');
    expect(db._stmt.bind).toHaveBeenCalledWith(
      "rs-1",
      "https://dots-events.0g0.xyz/mcp",
      "dots-events",
      '["events:read","events:subscribe"]',
      '["user-1"]',
      "user-1",
    );
  });
});

describe("updateResourceServer", () => {
  it("name / allowed_scopes / allowed_subjects を更新して返す", async () => {
    const updated: ResourceServer = {
      ...baseResource,
      name: "renamed",
      allowed_scopes: '["events:read"]',
      allowed_subjects: '["user-1","user-2"]',
    };
    const db = makeD1Mock(updated);
    const result = await updateResourceServer(db, "rs-1", {
      name: "renamed",
      allowedScopes: '["events:read"]',
      allowedSubjects: '["user-1","user-2"]',
    });
    expect(result).toEqual(updated);
    expect(db._stmt.bind).toHaveBeenCalledWith(
      "renamed",
      '["events:read"]',
      '["user-1","user-2"]',
      "rs-1",
    );
  });
});

describe("deleteResourceServer", () => {
  it("削除SQLを実行する", async () => {
    const db = makeD1Mock(null);
    await deleteResourceServer(db, "rs-1");
    expect(db.prepare).toHaveBeenCalledWith("DELETE FROM resource_servers WHERE id = ?");
  });
});
