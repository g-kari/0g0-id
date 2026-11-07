import { describe, expect, it } from "vite-plus/test";
import { loginEventFilters, parseLoginEventQuery } from "./login-event-filters";

describe("parseLoginEventQuery", () => {
  it("keeps the unfiltered 50-row default", () => {
    expect(parseLoginEventQuery(new URLSearchParams())).toEqual({
      limit: 50,
      offset: 0,
      period: "all",
      userId: undefined,
      country: undefined,
      provider: undefined,
    });
  });
  it("accepts combined exact-match filters, unknown country and safe paging", () => {
    expect(
      parseLoginEventQuery(
        new URLSearchParams(
          "user_id=user-1&country=unknown&provider=x&period=7d&limit=100&offset=50",
        ),
      ),
    ).toEqual({
      userId: "user-1",
      country: "unknown",
      provider: "x",
      period: "7d",
      limit: 100,
      offset: 50,
    });
  });
  it.each([
    "user_id=",
    "user_id=x%27%20OR%201%3D1",
    `user_id=${"a".repeat(129)}`,
    "country=jp",
    "country=JPN",
    "country=",
    "provider=unknown",
    "provider=",
    "period=",
    "period=12h",
    "limit=0",
    "limit=101",
    "limit=01.5",
    "offset=-1",
    "offset=9007199254740992",
    "limit=50&limit=100",
    "country=JP&country=US",
    "user=typo",
    `user_id=${"a".repeat(2100)}`,
  ])("rejects malformed or ambiguous query: %s", (search) => {
    expect(parseLoginEventQuery(new URLSearchParams(search))).toHaveProperty("error");
  });
  it.each(["google", "line", "twitch", "github", "x"])(
    "accepts supported provider %s",
    (provider) => {
      expect(parseLoginEventQuery(new URLSearchParams({ provider }))).not.toHaveProperty("error");
    },
  );
  it.each([
    ["24h", 1],
    ["7d", 7],
    ["30d", 30],
  ] as const)("resolves %s from the same UTC instant", (period, days) => {
    const query = parseLoginEventQuery(new URLSearchParams({ period }));
    if ("error" in query) throw new Error(query.error);
    const now = Date.parse("2026-10-02T02:00:00.123Z");
    expect(loginEventFilters(query, now).sinceIso).toBe(
      new Date(now - days * 86400000).toISOString(),
    );
  });
  it("all has no time cutoff", () => {
    const query = parseLoginEventQuery(new URLSearchParams("period=all"));
    if ("error" in query) throw new Error(query.error);
    expect(loginEventFilters(query).sinceIso).toBeUndefined();
  });
});
