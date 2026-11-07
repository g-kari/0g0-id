import { describe, expect, it } from "vite-plus/test";
import {
  AUDIT_ACTIONS,
  AUDIT_PAGE_SIZE,
  auditQueryParams,
  auditTargetHref,
  parseAuditQuery,
  readAuditPage,
  type AuditQuery,
} from "../audit-log-view";

const adminId = "00000000-0000-0000-0000-000000000001";
const targetId = "00000000-0000-0000-0000-000000000002";
const otherId = "00000000-0000-0000-0000-000000000003";
const allFilters: AuditQuery = { adminUserId: adminId, targetId, action: "user.ban", offset: 0 };
const log = {
  id: "synthetic-log-id",
  created_at: "2026-10-02 01:00:00",
  admin_user_id: adminId,
  action: "user.ban",
  target_type: "user",
  target_id: targetId,
  status: "success",
};

function page(data: unknown[] = [log], total = data.length, offset = 0) {
  return { data, pagination: { total, limit: AUDIT_PAGE_SIZE, offset } };
}

describe("parseAuditQuery", () => {
  it("defaults all filters to absent and starts at the fixed 50-row first page", () => {
    expect(AUDIT_PAGE_SIZE).toBe(50);
    expect(parseAuditQuery(new URLSearchParams())).toEqual({
      adminUserId: undefined,
      targetId: undefined,
      action: undefined,
      offset: 0,
    });
  });

  it("preserves three exact-match filters and the page offset together", () => {
    expect(
      parseAuditQuery(
        new URLSearchParams({
          admin_user_id: adminId,
          target_id: targetId,
          action: "user.ban",
          offset: "50",
        }),
      ),
    ).toEqual({ ...allFilters, offset: 50 });
  });

  it.each(AUDIT_ACTIONS)("accepts the suggested action %s", (action) => {
    expect(parseAuditQuery(new URLSearchParams({ action }))).toMatchObject({ action, offset: 0 });
  });

  it("accepts unknown but well-formed future actions without broadening the filter", () => {
    expect(parseAuditQuery(new URLSearchParams({ action: "service.future_action" }))).toMatchObject(
      {
        action: "service.future_action",
        offset: 0,
      },
    );
  });

  it.each([
    "admin_user_id=",
    "admin_user_id=not-a-uuid",
    `admin_user_id=${adminId}%20`,
    "target_id=",
    "target_id=https%3A%2F%2Fevil.example",
    "action=",
    "action=User.ban",
    "action=user.ban%20",
    "action=user.%3Cscript%3E",
    "action=user.ban%27+OR+1%3D1--",
    "action=user.ban&action=user.unban",
    `admin_user_id=${adminId}&admin_user_id=${adminId}`,
    `target_id=${targetId}&target_id=${targetId}`,
    "offset=0&offset=50",
    "limit=50",
    "status=failure",
    "unknown=",
    "offset=",
    "offset=-50",
    "offset=1",
    "offset=49",
    "offset=51",
    "offset=50.0",
    "offset=5e1",
    "offset=%2B50",
    "offset=Infinity",
    "offset=9007199254741000",
    "offset=00000000000000000",
  ])("fails closed for malformed investigation URL %s", (search) => {
    const result = parseAuditQuery(new URLSearchParams(search));
    expect(result).toEqual({ error: expect.any(String) });
    expect(result).not.toHaveProperty("offset");
    expect(result).not.toHaveProperty("adminUserId");
  });

  it("rejects excessive action and URL lengths instead of silently dropping them", () => {
    expect(parseAuditQuery(new URLSearchParams({ action: `user.${"a".repeat(124)}` }))).toEqual({
      error: expect.any(String),
    });
    expect(parseAuditQuery(new URLSearchParams({ target_id: "a".repeat(2048) }))).toEqual({
      error: "検索条件が長すぎます",
    });
  });

  it.each([0, 50, 100, 500])("accepts the page-aligned offset %i", (offset) => {
    expect(parseAuditQuery(new URLSearchParams({ offset: String(offset) }))).toMatchObject({
      offset,
    });
  });
});

describe("auditQueryParams", () => {
  it("represents the all-filter defaults without query parameters", () => {
    expect(auditQueryParams({ offset: 0 }).toString()).toBe("");
  });

  it("round-trips every filter across pages without adding response fields or a variable limit", () => {
    const query = { ...allFilters, offset: 50 };
    const params = auditQueryParams(query);
    expect([...params.entries()]).toEqual([
      ["admin_user_id", adminId],
      ["target_id", targetId],
      ["action", "user.ban"],
      ["offset", "50"],
    ]);
    expect(parseAuditQuery(params)).toEqual(query);
    expect(auditQueryParams({ ...query, offset: 0 }).has("offset")).toBe(false);
  });
});

describe("readAuditPage", () => {
  it("projects only display fields and drops secret-like details, errors, IPs, and extra API fields", () => {
    const raw = {
      ...log,
      status: "failure",
      details: JSON.stringify({ client_secret: "SYNTHETIC_SECRET", token: "SYNTHETIC_TOKEN" }),
      error_message: "SYNTHETIC_ERROR_PAYLOAD",
      ip_address: "192.0.2.42",
      target_url: "https://evil.example/SYNTHETIC_URL_PAYLOAD",
    };
    const result = readAuditPage(page([raw]), allFilters);
    expect(result).toEqual({
      total: 1,
      rows: [
        {
          createdAt: "2026-10-02T01:00:00Z",
          adminUserId: adminId,
          action: "user.ban",
          targetType: "user",
          targetId,
          status: "failure",
        },
      ],
    });
    const serialized = JSON.stringify(result);
    for (const excluded of [
      "details",
      "client_secret",
      "SYNTHETIC_SECRET",
      "SYNTHETIC_TOKEN",
      "error_message",
      "SYNTHETIC_ERROR_PAYLOAD",
      "ip_address",
      "192.0.2.42",
      "target_url",
      "SYNTHETIC_URL_PAYLOAD",
      "synthetic-log-id",
    ]) {
      expect(serialized).not.toContain(excluded);
    }
  });

  it("never reads excluded details or error properties while projecting a response", () => {
    const raw = { ...log };
    for (const key of ["details", "error_message", "ip_address"]) {
      Object.defineProperty(raw, key, {
        get() {
          throw new Error("excluded property must not be accessed");
        },
      });
    }
    expect(readAuditPage(page([raw]), { offset: 0 }).rows).toHaveLength(1);
  });

  it("uses conservative labels for unknown values and never treats unknown status as success", () => {
    const raw = {
      created_at: "<script>unsafe date</script>",
      admin_user_id: "mailto:admin@example.com",
      action: "<img src=x onerror=alert(1)>",
      target_type: "https://evil.example",
      target_id: "../services/new",
      status: true,
    };
    expect(readAuditPage(page([raw]), { offset: 0 }).rows).toEqual([
      {
        createdAt: "",
        adminUserId: "ID形式不明",
        action: "不明な操作",
        targetType: "other",
        targetId: "ID形式不明",
        status: "unknown",
      },
    ]);
    expect(readAuditPage(page([{}]), { offset: 0 }).rows[0].status).toBe("unknown");
  });

  it("preserves valid future actions and deleted-target UUIDs without resolving current records", () => {
    const raw = {
      ...log,
      action: "service.future_action",
      target_type: "service",
      status: "success",
    };
    const [row] = readAuditPage(page([raw]), { offset: 0 }).rows;
    expect(row).toMatchObject({
      action: "service.future_action",
      targetType: "service",
      targetId,
      status: "success",
    });
    expect(auditTargetHref(row.targetType, row.targetId)).toBe(`/services/${targetId}`);
  });

  it.each([
    ["2026-10-02 01:00:00", "2026-10-02T01:00:00Z"],
    ["2026-10-02 01:00:00.123", "2026-10-02T01:00:00.123Z"],
    ["2026-10-02T01:00:00", "2026-10-02T01:00:00Z"],
    ["2026-10-02T01:00:00.123Z", "2026-10-02T01:00:00.123Z"],
    ["2026-10-02T10:00:00+09:00", "2026-10-02T10:00:00+09:00"],
    ["2026-10-01T20:30:00-04:30", "2026-10-01T20:30:00-04:30"],
    ["2026-10-02 10:00:00+09:00", "2026-10-02T10:00:00+09:00"],
  ])(
    "makes timestamps timezone-explicit without losing recorded offsets: %s",
    (createdAt, normalized) => {
      expect(
        readAuditPage(page([{ ...log, created_at: createdAt }]), { offset: 0 }).rows[0].createdAt,
      ).toBe(normalized);
    },
  );

  it("treats timezone-less SQLite timestamps as the same instant as zoned UTC ISO timestamps", () => {
    const timestamps = ["2026-10-02 01:00:00", "2026-10-02T01:00:00Z", "2026-10-02T10:00:00+09:00"];
    const rows = readAuditPage(
      page(timestamps.map((createdAt) => ({ ...log, created_at: createdAt }))),
      { offset: 0 },
    ).rows;
    expect(rows[0].createdAt).toBe(rows[1].createdAt);
    expect(rows.map((row) => Date.parse(row.createdAt))).toEqual(
      Array.from({ length: 3 }, () => Date.UTC(2026, 9, 2, 1, 0, 0)),
    );
  });

  it.each([
    null,
    123,
    "2026-99-99 99:99:99",
    "tomorrow",
    "2026-10-02T01:00:00Z<script>",
    "2026-10-02T01:00:00+25:00",
  ])("labels malformed timestamps without rendering raw values: %s", (createdAt) => {
    expect(
      readAuditPage(page([{ ...log, created_at: createdAt }]), { offset: 0 }).rows[0].createdAt,
    ).toBe("");
  });

  it.each(["admin_user_id", "target_id", "action"])(
    "rejects any row that fails the requested %s filter",
    (field) => {
      const value = field === "action" ? "user.unban" : otherId;
      expect(() => readAuditPage(page([log, { ...log, [field]: value }]), allFilters)).toThrow(
        "audit filters do not match",
      );
    },
  );

  it("accepts a combined-filter match and an actual no-result response", () => {
    expect(readAuditPage(page(), allFilters)).toMatchObject({
      total: 1,
      rows: [{ action: "user.ban" }],
    });
    expect(readAuditPage(page([], 0), allFilters)).toEqual({ rows: [], total: 0 });
  });

  it("accepts exactly 50 rows on page one and the 51st row on page two", () => {
    expect(
      readAuditPage(
        page(
          Array.from({ length: 50 }, () => ({ ...log })),
          51,
        ),
        allFilters,
      ).rows,
    ).toHaveLength(50);
    expect(readAuditPage(page([log], 51, 50), { ...allFilters, offset: 50 })).toMatchObject({
      total: 51,
      rows: [{ targetId }],
    });
  });

  it("accepts an empty out-of-range page so the UI can clamp it while keeping filters", () => {
    expect(readAuditPage(page([], 51, 100), { ...allFilters, offset: 100 })).toEqual({
      rows: [],
      total: 51,
    });
  });

  it.each([
    null,
    [],
    {},
    { data: [], total: 0 },
    { data: {}, pagination: { total: 0, limit: 50, offset: 0 } },
    { data: [], pagination: null },
    { data: [], pagination: [] },
  ])("rejects an incompatible API envelope %#", (body) => {
    expect(() => readAuditPage(body, { offset: 0 })).toThrow("invalid audit response");
  });

  it.each([
    { total: -1 },
    { total: 0.5 },
    { total: "1" },
    { total: Number.POSITIVE_INFINITY },
    { total: Number.MAX_SAFE_INTEGER + 1 },
    { total: undefined },
    { limit: 100 },
    { limit: "50" },
    { limit: undefined },
    { offset: 50 },
    { offset: "0" },
    { offset: undefined },
  ])("rejects broken or mismatched pagination %#", (pagination) => {
    const body = page();
    expect(() =>
      readAuditPage({ ...body, pagination: { ...body.pagination, ...pagination } }, { offset: 0 }),
    ).toThrow("invalid audit pagination");
  });

  it.each([
    page([], 1),
    page([log], 0),
    page(
      Array.from({ length: 51 }, () => ({ ...log })),
      51,
    ),
    page([log], 51),
  ])("rejects missing, extra, or truncated rows even with plausible pagination %#", (body) => {
    expect(() => readAuditPage(body, { offset: 0 })).toThrow("invalid audit pagination");
  });

  it("rejects a missing final-page row and malformed row shapes", () => {
    expect(() => readAuditPage(page([], 51, 50), { offset: 50 })).toThrow(
      "invalid audit pagination",
    );
    for (const row of [null, [], "not a row"]) {
      expect(() => readAuditPage(page([row]), { offset: 0 })).toThrow("audit filters do not match");
    }
  });
});

describe("auditTargetHref", () => {
  it("links valid UUIDs only through the two existing detail routes, including deleted targets", () => {
    expect(auditTargetHref("user", targetId)).toBe(`/users/${targetId}`);
    expect(auditTargetHref("service", targetId)).toBe(`/services/${targetId}`);
  });

  it("canonicalizes uppercase UUID destinations while preserving the recorded display IDs", () => {
    const recordedId = "ABCDEF01-ABCD-ABCD-ABCD-ABCDEF012345";
    const [row] = readAuditPage(
      page([{ ...log, admin_user_id: recordedId, target_id: recordedId }]),
      { offset: 0 },
    ).rows;
    expect(row.adminUserId).toBe(recordedId);
    expect(row.targetId).toBe(recordedId);
    expect(auditTargetHref("user", row.adminUserId)).toBe(`/users/${recordedId.toLowerCase()}`);
    expect(auditTargetHref("service", row.targetId)).toBe(`/services/${recordedId.toLowerCase()}`);
  });

  it.each(["other", "User", "unknown", "https://evil.example", "../services", "user/delete"])(
    "does not derive a link from an unknown target type %s",
    (targetType) => {
      expect(auditTargetHref(targetType, targetId)).toBeUndefined();
    },
  );

  it.each([
    "",
    "ID形式不明",
    "../new",
    "https://evil.example",
    `${targetId}?delete=true`,
    `${targetId}/delete`,
  ])("does not link an invalid or route-manipulating ID %s", (id) => {
    expect(auditTargetHref("user", id)).toBeUndefined();
    expect(auditTargetHref("service", id)).toBeUndefined();
  });
});
