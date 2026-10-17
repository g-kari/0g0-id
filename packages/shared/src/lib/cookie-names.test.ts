import { describe, it, expect } from "vite-plus/test";
import { COOKIE_NAMES } from "./cookie-names";

describe("COOKIE_NAMES", () => {
  it("全Cookie名が __Host- プレフィックスを持つ", () => {
    for (const [, value] of Object.entries(COOKIE_NAMES)) {
      expect(value).toMatch(/^__Host-/);
    }
  });

  it("admin セッション系Cookie名", () => {
    expect(COOKIE_NAMES.ADMIN_SESSION).toBe("__Host-admin-session");
    expect(COOKIE_NAMES.ADMIN_STATE).toBe("__Host-admin-oauth-state");
  });

  it("user セッション系Cookie名", () => {
    expect(COOKIE_NAMES.USER_SESSION).toBe("__Host-user-session");
    expect(COOKIE_NAMES.USER_STATE).toBe("__Host-user-oauth-state");
  });

  it("IdP 系Cookie名", () => {
    expect(COOKIE_NAMES.IDP_STATE).toBe("__Host-oauth-state");
    expect(COOKIE_NAMES.IDP_PKCE).toBe("__Host-oauth-pkce");
  });

  it("重複する値がない", () => {
    const values = Object.values(COOKIE_NAMES);
    expect(new Set(values).size).toBe(values.length);
  });
});
