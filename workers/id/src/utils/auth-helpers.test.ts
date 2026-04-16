import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

vi.mock("@0g0-id/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@0g0-id/shared")>();
  return {
    ...actual,
    linkProvider: vi.fn(),
  };
});

import { linkProvider, signCookie } from "@0g0-id/shared";
import type { User } from "@0g0-id/shared";
import {
  matchesExtraBffOrigins,
  isAllowedRedirectTo,
  isBffOrigin,
  parseStateFromCookie,
  handleProviderLink,
} from "./auth-helpers";

const mockLinkProvider = vi.mocked(linkProvider);
const mockDb = {} as D1Database;

const mockUser: User = {
  id: "user-1",
  google_sub: "google-123",
  line_sub: null,
  twitch_sub: null,
  github_sub: null,
  x_sub: null,
  email: "test@example.com",
  email_verified: 1,
  name: "Test User",
  picture: null,
  phone: null,
  address: null,
  role: "user",
  banned_at: null,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

// ============================================================
// matchesExtraBffOrigins
// ============================================================
describe("matchesExtraBffOrigins", () => {
  it("カンマ区切りリストのオリジンと一致する場合 true を返す", () => {
    const url = new URL("https://app.example.com/callback");
    expect(matchesExtraBffOrigins(url, "https://app.example.com,https://other.example.com")).toBe(
      true,
    );
  });

  it("リスト内の2番目のオリジンとも一致する", () => {
    const url = new URL("https://other.example.com/path");
    expect(matchesExtraBffOrigins(url, "https://app.example.com,https://other.example.com")).toBe(
      true,
    );
  });

  it("リストのどのオリジンとも一致しない場合 false を返す", () => {
    const url = new URL("https://evil.com/callback");
    expect(matchesExtraBffOrigins(url, "https://app.example.com,https://other.example.com")).toBe(
      false,
    );
  });

  it("extraBffOrigins が undefined の場合 false を返す", () => {
    const url = new URL("https://app.example.com/callback");
    expect(matchesExtraBffOrigins(url, undefined)).toBe(false);
  });

  it("extraBffOrigins が空文字列の場合 false を返す", () => {
    const url = new URL("https://app.example.com/callback");
    expect(matchesExtraBffOrigins(url, "")).toBe(false);
  });

  it("リスト内の不正なURLは無視される", () => {
    const url = new URL("https://app.example.com/callback");
    expect(matchesExtraBffOrigins(url, "not-a-url,https://app.example.com")).toBe(true);
  });

  it("リスト内の全てが不正なURLの場合 false を返す", () => {
    const url = new URL("https://app.example.com/callback");
    expect(matchesExtraBffOrigins(url, "not-a-url,also-bad")).toBe(false);
  });

  it("スペースを含むカンマ区切りを正しくトリムする", () => {
    const url = new URL("https://app.example.com/callback");
    expect(matchesExtraBffOrigins(url, " https://app.example.com , https://other.com ")).toBe(true);
  });
});

// ============================================================
// isAllowedRedirectTo
// ============================================================
describe("isAllowedRedirectTo", () => {
  const idpOrigin = "https://id.0g0.xyz";

  it("同一登録可能ドメインのサブドメインを許可する（user.0g0.xyz）", () => {
    expect(isAllowedRedirectTo("https://user.0g0.xyz/callback", idpOrigin)).toBe(true);
  });

  it("同一登録可能ドメインのサブドメインを許可する（admin.0g0.xyz）", () => {
    expect(isAllowedRedirectTo("https://admin.0g0.xyz/callback", idpOrigin)).toBe(true);
  });

  it("登録可能ドメイン自体を許可する（0g0.xyz）", () => {
    expect(isAllowedRedirectTo("https://0g0.xyz/callback", idpOrigin)).toBe(true);
  });

  it("異なる登録可能ドメインを拒否する（evil.com）", () => {
    expect(isAllowedRedirectTo("https://evil.com/callback", idpOrigin)).toBe(false);
  });

  it("PSL private ドメイン: evil.github.io を拒否する（github.io は PSL private suffix）", () => {
    const githubIdpOrigin = "https://myapp.github.io";
    expect(isAllowedRedirectTo("https://evil.github.io/callback", githubIdpOrigin)).toBe(false);
  });

  it("IPアドレスの IDP_ORIGIN では親ドメイン導出をスキップする", () => {
    const ipIdpOrigin = "https://192.168.1.1";
    // IPアドレスの場合、ドメインマッチはスキップされるので EXTRA_BFF_ORIGINS がないと false
    expect(isAllowedRedirectTo("https://192.168.1.2/callback", ipIdpOrigin)).toBe(false);
  });

  it("IPアドレスの IDP_ORIGIN でも EXTRA_BFF_ORIGINS で許可できる", () => {
    const ipIdpOrigin = "https://192.168.1.1";
    expect(
      isAllowedRedirectTo("https://192.168.1.2/callback", ipIdpOrigin, "https://192.168.1.2"),
    ).toBe(true);
  });

  it("HTTP を拒否する（HTTPS必須）", () => {
    expect(isAllowedRedirectTo("http://user.0g0.xyz/callback", idpOrigin)).toBe(false);
  });

  it("不正なURLを拒否する", () => {
    expect(isAllowedRedirectTo("not-a-url", idpOrigin)).toBe(false);
  });

  it("空文字列を拒否する", () => {
    expect(isAllowedRedirectTo("", idpOrigin)).toBe(false);
  });

  it("EXTRA_BFF_ORIGINS でマッチする外部ドメインを許可する", () => {
    expect(
      isAllowedRedirectTo(
        "https://external.example.com/callback",
        idpOrigin,
        "https://external.example.com",
      ),
    ).toBe(true);
  });

  it("EXTRA_BFF_ORIGINS にもドメインにもマッチしない場合は拒否する", () => {
    expect(
      isAllowedRedirectTo("https://evil.com/callback", idpOrigin, "https://external.example.com"),
    ).toBe(false);
  });
});

// ============================================================
// isBffOrigin
// ============================================================
describe("isBffOrigin", () => {
  const userOrigin = "https://user.0g0.xyz";
  const adminOrigin = "https://admin.0g0.xyz";

  it("USER_ORIGIN と完全一致する場合 true を返す", () => {
    expect(isBffOrigin("https://user.0g0.xyz/callback", userOrigin, adminOrigin)).toBe(true);
  });

  it("ADMIN_ORIGIN と完全一致する場合 true を返す", () => {
    expect(isBffOrigin("https://admin.0g0.xyz/callback", userOrigin, adminOrigin)).toBe(true);
  });

  it("どちらのオリジンとも一致しない場合 false を返す", () => {
    expect(isBffOrigin("https://other.0g0.xyz/callback", userOrigin, adminOrigin)).toBe(false);
  });

  it("HTTP を拒否する", () => {
    expect(isBffOrigin("http://user.0g0.xyz/callback", userOrigin, adminOrigin)).toBe(false);
  });

  it("不正なURLを拒否する", () => {
    expect(isBffOrigin("not-a-url", userOrigin, adminOrigin)).toBe(false);
  });

  it("EXTRA_BFF_ORIGINS でマッチする場合 true を返す", () => {
    expect(
      isBffOrigin(
        "https://external.example.com/callback",
        userOrigin,
        adminOrigin,
        "https://external.example.com",
      ),
    ).toBe(true);
  });

  it("EXTRA_BFF_ORIGINS にもオリジンにもマッチしない場合 false を返す", () => {
    expect(
      isBffOrigin(
        "https://evil.com/callback",
        userOrigin,
        adminOrigin,
        "https://external.example.com",
      ),
    ).toBe(false);
  });
});

// ============================================================
// parseStateFromCookie
// ============================================================
describe("parseStateFromCookie", () => {
  const secret = "test-secret-key-for-cookie-signing";

  it("正しく署名されたCookieから OAuthStateCookieData を返す", async () => {
    const stateData = {
      idState: "state-123",
      redirectTo: "https://user.0g0.xyz/callback",
      bffState: "bff-state-456",
      provider: "google",
    };
    const signed = await signCookie(JSON.stringify(stateData), secret);
    const result = await parseStateFromCookie(signed, secret);

    expect(result).not.toBeNull();
    expect(result!.idState).toBe("state-123");
    expect(result!.redirectTo).toBe("https://user.0g0.xyz/callback");
    expect(result!.bffState).toBe("bff-state-456");
  });

  it("改ざんされたCookieの場合 null を返す", async () => {
    const stateData = {
      idState: "state-123",
      redirectTo: "https://user.0g0.xyz/callback",
      bffState: "bff-state-456",
      provider: "google",
    };
    const signed = await signCookie(JSON.stringify(stateData), secret);
    const tampered = signed + "tampered";
    const result = await parseStateFromCookie(tampered, secret);

    expect(result).toBeNull();
  });

  it("異なるシークレットで署名されたCookieの場合 null を返す", async () => {
    const stateData = {
      idState: "state-123",
      redirectTo: "https://user.0g0.xyz/callback",
      bffState: "bff-state-456",
      provider: "google",
    };
    const signed = await signCookie(JSON.stringify(stateData), "different-secret");
    const result = await parseStateFromCookie(signed, secret);

    expect(result).toBeNull();
  });

  it("署名は正しいがJSONが不正な場合 null を返す", async () => {
    const signed = await signCookie("not-valid-json{{{", secret);
    const result = await parseStateFromCookie(signed, secret);

    expect(result).toBeNull();
  });

  it("必須フィールド idState が欠けている場合 null を返す", async () => {
    const incomplete = { redirectTo: "https://example.com", bffState: "bff" };
    const signed = await signCookie(JSON.stringify(incomplete), secret);
    const result = await parseStateFromCookie(signed, secret);

    expect(result).toBeNull();
  });

  it("必須フィールド redirectTo が欠けている場合 null を返す", async () => {
    const incomplete = { idState: "state", bffState: "bff" };
    const signed = await signCookie(JSON.stringify(incomplete), secret);
    const result = await parseStateFromCookie(signed, secret);

    expect(result).toBeNull();
  });

  it("必須フィールド bffState が欠けている場合 null を返す", async () => {
    const incomplete = { idState: "state", redirectTo: "https://example.com" };
    const signed = await signCookie(JSON.stringify(incomplete), secret);
    const result = await parseStateFromCookie(signed, secret);

    expect(result).toBeNull();
  });

  it("オプションフィールド（linkUserId, serviceId等）を含むデータを正しくパースする", async () => {
    const stateData = {
      idState: "state-123",
      redirectTo: "https://user.0g0.xyz/callback",
      bffState: "bff-state-456",
      provider: "google",
      linkUserId: "user-1",
      serviceId: "service-1",
      nonce: "nonce-789",
    };
    const signed = await signCookie(JSON.stringify(stateData), secret);
    const result = await parseStateFromCookie(signed, secret);

    expect(result).not.toBeNull();
    expect(result!.linkUserId).toBe("user-1");
    expect(result!.serviceId).toBe("service-1");
    expect(result!.nonce).toBe("nonce-789");
  });
});

// ============================================================
// handleProviderLink
// ============================================================
describe("handleProviderLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("成功時に { ok: true, user } を返す", async () => {
    mockLinkProvider.mockResolvedValue(mockUser);

    const result = await handleProviderLink(mockDb, "user-1", "google", "google-sub-123");

    expect(result).toEqual({ ok: true, user: mockUser });
    expect(mockLinkProvider).toHaveBeenCalledWith(mockDb, "user-1", "google", "google-sub-123");
  });

  it("PROVIDER_ALREADY_LINKED エラーの場合 { ok: false } を返す", async () => {
    mockLinkProvider.mockRejectedValue(new Error("PROVIDER_ALREADY_LINKED"));

    const result = await handleProviderLink(mockDb, "user-1", "google", "google-sub-123");

    expect(result).toEqual({ ok: false });
  });

  it("PROVIDER_ALREADY_LINKED 以外のエラーは再スローする", async () => {
    const otherError = new Error("Database connection failed");
    mockLinkProvider.mockRejectedValue(otherError);

    await expect(handleProviderLink(mockDb, "user-1", "google", "google-sub-123")).rejects.toThrow(
      "Database connection failed",
    );
  });

  it("Error インスタンスでないエラーは再スローする", async () => {
    mockLinkProvider.mockRejectedValue("string error");

    await expect(handleProviderLink(mockDb, "user-1", "google", "google-sub-123")).rejects.toBe(
      "string error",
    );
  });
});
