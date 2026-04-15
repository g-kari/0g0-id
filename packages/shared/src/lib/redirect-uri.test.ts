import { describe, it, expect } from "vite-plus/test";
import { normalizeRedirectUri } from "./redirect-uri";

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
});
