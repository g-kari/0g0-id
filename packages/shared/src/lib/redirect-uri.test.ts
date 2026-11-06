import { describe, it, expect } from "vite-plus/test";
import { normalizeRedirectUri, matchRedirectUri, isLoopbackHost } from "./redirect-uri";

describe("normalizeRedirectUri", () => {
  it("有効なHTTPS URLはそのまま返す", () => {
    const result = normalizeRedirectUri("https://example.com/callback");
    expect(result).toBe("https://example.com/callback");
  });

  it("ホスト名を小文字化する", () => {
    const result = normalizeRedirectUri("https://EXAMPLE.COM/callback");
    expect(result).toBe("https://example.com/callback");
  });

  it("デフォルトポート443（HTTPS）を除去する", () => {
    const result = normalizeRedirectUri("https://example.com:443/callback");
    expect(result).toBe("https://example.com/callback");
  });

  it("デフォルトポート80（HTTP）を除去する", () => {
    const result = normalizeRedirectUri("http://localhost:80/callback");
    expect(result).toBe("http://localhost/callback");
  });

  it("非デフォルトポートは保持する", () => {
    const result = normalizeRedirectUri("https://example.com:8443/callback");
    expect(result).toBe("https://example.com:8443/callback");
  });

  it("HTTP localhostは許可", () => {
    const result = normalizeRedirectUri("http://localhost:3000/callback");
    expect(result).toBe("http://localhost:3000/callback");
  });

  it("HTTP 127.0.0.1は許可", () => {
    const result = normalizeRedirectUri("http://127.0.0.1:3000/callback");
    expect(result).toBe("http://127.0.0.1:3000/callback");
  });

  it("HTTP非localhostはnullを返す", () => {
    expect(normalizeRedirectUri("http://example.com/callback")).toBeNull();
    expect(normalizeRedirectUri("http://sub.example.com/callback")).toBeNull();
  });

  it("fragmentを含むURLはnullを返す", () => {
    expect(normalizeRedirectUri("https://example.com/callback#fragment")).toBeNull();
    expect(normalizeRedirectUri("https://example.com/#")).toBeNull();
  });

  it("無効なURLはnullを返す", () => {
    expect(normalizeRedirectUri("not-a-url")).toBeNull();
    expect(normalizeRedirectUri("")).toBeNull();
    expect(normalizeRedirectUri("javascript:alert(1)")).toBeNull();
  });

  it("クエリパラメータは保持する", () => {
    const result = normalizeRedirectUri("https://example.com/callback?foo=bar");
    expect(result).toBe("https://example.com/callback?foo=bar");
  });

  it("パスは保持する", () => {
    const result = normalizeRedirectUri("https://example.com/app/oauth/callback");
    expect(result).toBe("https://example.com/app/oauth/callback");
  });

  it("localhostポートなしも許可", () => {
    const result = normalizeRedirectUri("http://localhost/callback");
    expect(result).toBe("http://localhost/callback");
  });

  it("HTTP [::1]（IPv6 loopback）は許可", () => {
    const result = normalizeRedirectUri("http://[::1]:3000/callback");
    expect(result).toBe("http://[::1]:3000/callback");
  });

  it("loopbackでもhttp以外の任意schemeはnullを返す", () => {
    expect(normalizeRedirectUri("ftp://localhost/callback")).toBeNull();
    expect(normalizeRedirectUri("ws://127.0.0.1/callback")).toBeNull();
  });

  it("IPv6の非loopbackアドレスのHTTPはnullを返す", () => {
    expect(normalizeRedirectUri("http://[2001:db8::1]/callback")).toBeNull();
  });
});

describe("isLoopbackHost", () => {
  it("localhost / 127.0.0.1 / ::1 のみ true", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.2")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});

describe("matchRedirectUri", () => {
  it("非loopbackは完全一致のみ true", () => {
    expect(
      matchRedirectUri(
        "https://chatgpt.com/connector/oauth/callback",
        "https://chatgpt.com/connector/oauth/callback",
      ),
    ).toBe(true);
    expect(
      matchRedirectUri("https://chatgpt.com/connector/oauth/callback", "https://chatgpt.com/other"),
    ).toBe(false);
    expect(matchRedirectUri("https://example.com:8443/cb", "https://example.com:9443/cb")).toBe(
      false,
    );
  });

  it("loopback同士はポートを無視して一致する（localhost / 127.0.0.1 / ::1 を同一視）", () => {
    expect(matchRedirectUri("http://localhost:3000/cb", "http://127.0.0.1:51234/cb")).toBe(true);
    expect(matchRedirectUri("http://[::1]:3000/cb", "http://localhost:51234/cb")).toBe(true);
    expect(matchRedirectUri("http://localhost:3000/cb", "http://localhost:3000/other")).toBe(false);
    expect(matchRedirectUri("http://localhost:3000/cb", "https://localhost:3000/cb")).toBe(false);
  });

  it("loopbackと非loopbackの混在は完全一致で判定する", () => {
    expect(matchRedirectUri("http://localhost:3000/cb", "http://example.com:3000/cb")).toBe(false);
  });
});
