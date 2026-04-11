import { describe, it, expect } from "vite-plus/test";
import { signCookie, verifyCookie } from "./cookie";

const SECRET = "test-secret-key-32bytes-or-more!!";
const OTHER_SECRET = "different-secret-key-32bytes!!!!!";

describe("signCookie / verifyCookie", () => {
  describe("signCookie", () => {
    it("payload.signature 形式の文字列を返す", async () => {
      const signed = await signCookie("hello", SECRET);
      expect(signed).toContain(".");
      const parts = signed.split(".");
      expect(parts.length).toBe(2);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
    });

    it("URLセーフ文字のみを含む（+/= なし）", async () => {
      const signed = await signCookie("hello world", SECRET);
      expect(signed).not.toContain("+");
      expect(signed).not.toContain("/");
      expect(signed).not.toContain("=");
    });

    it("同一 payload + secret から常に同じ署名が生成される（決定的）", async () => {
      const s1 = await signCookie("test-payload", SECRET);
      const s2 = await signCookie("test-payload", SECRET);
      expect(s1).toBe(s2);
    });

    it("異なる payload は異なる署名になる", async () => {
      const s1 = await signCookie("payload-a", SECRET);
      const s2 = await signCookie("payload-b", SECRET);
      expect(s1).not.toBe(s2);
    });

    it("異なる secret は異なる署名になる", async () => {
      const s1 = await signCookie("same-payload", SECRET);
      const s2 = await signCookie("same-payload", OTHER_SECRET);
      expect(s1).not.toBe(s2);
    });

    it("JSON文字列を含むペイロードを正しくエンコードする", async () => {
      const payload = JSON.stringify({
        state: "abc123",
        redirectTo: "https://example.com/callback",
      });
      const signed = await signCookie(payload, SECRET);
      expect(signed).toBeTruthy();
      expect(signed).toContain(".");
    });

    it("空文字列のペイロードも署名できる", async () => {
      const signed = await signCookie("", SECRET);
      expect(signed).toContain(".");
    });

    it("日本語や特殊文字を含むペイロードも署名できる", async () => {
      const payload = "テスト payload with special chars: !@#$%^&*()";
      const signed = await signCookie(payload, SECRET);
      expect(signed).toContain(".");
    });
  });

  describe("verifyCookie", () => {
    it("正しいシークレットで署名されたCookieの検証が成功し元のpayloadを返す", async () => {
      const payload = "original-payload";
      const signed = await signCookie(payload, SECRET);
      const result = await verifyCookie(signed, SECRET);
      expect(result).toBe(payload);
    });

    it("JSON文字列のラウンドトリップが正しく動作する", async () => {
      const payload = JSON.stringify({
        idState: "state-123",
        bffState: "bff-state-456",
        redirectTo: "https://app.example.com/callback",
        provider: "google",
        nonce: "nonce-789",
      });
      const signed = await signCookie(payload, SECRET);
      const result = await verifyCookie(signed, SECRET);
      expect(result).toBe(payload);
      const parsed = JSON.parse(result!);
      expect(parsed.idState).toBe("state-123");
      expect(parsed.provider).toBe("google");
    });

    it("異なるシークレットでは検証失敗し null を返す", async () => {
      const signed = await signCookie("payload", SECRET);
      const result = await verifyCookie(signed, OTHER_SECRET);
      expect(result).toBeNull();
    });

    it("シグネチャ部分を改ざんすると null を返す", async () => {
      const signed = await signCookie("payload", SECRET);
      const [payloadPart, sigPart] = signed.split(".");
      // シグネチャの一部を変更
      const tamperedSig = sigPart.slice(0, -4) + "XXXX";
      const tampered = `${payloadPart}.${tamperedSig}`;
      const result = await verifyCookie(tampered, SECRET);
      expect(result).toBeNull();
    });

    it("ペイロード部分を改ざんすると null を返す（セキュリティ: Cookie改ざん検知）", async () => {
      const signed = await signCookie("original-payload", SECRET);
      const [, sigPart] = signed.split(".");
      // 別のペイロードに正規のシグネチャを組み合わせる
      const fakePayload = btoa("evil-payload")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
      const tampered = `${fakePayload}.${sigPart}`;
      const result = await verifyCookie(tampered, SECRET);
      expect(result).toBeNull();
    });

    it("ドット区切りがない文字列は null を返す", async () => {
      const result = await verifyCookie("no-dot-separator-here", SECRET);
      expect(result).toBeNull();
    });

    it("空文字列は null を返す", async () => {
      const result = await verifyCookie("", SECRET);
      expect(result).toBeNull();
    });

    it("ペイロード部分が空（.signature）は null を返す", async () => {
      const result = await verifyCookie(".some-signature", SECRET);
      expect(result).toBeNull();
    });

    it("シグネチャ部分が空（payload.）は null を返す", async () => {
      const result = await verifyCookie("some-payload.", SECRET);
      expect(result).toBeNull();
    });

    it("不正な base64url 文字列は null を返す", async () => {
      const result = await verifyCookie("invalid!!!.invalid!!!", SECRET);
      expect(result).toBeNull();
    });

    it("空文字列ペイロードのラウンドトリップ", async () => {
      const signed = await signCookie("", SECRET);
      const result = await verifyCookie(signed, SECRET);
      expect(result).toBe("");
    });

    it("長い JSON ペイロードのラウンドトリップ", async () => {
      const payload = JSON.stringify({
        idState: "x".repeat(128),
        bffState: "y".repeat(1024),
        redirectTo: `https://example.com/${"a".repeat(500)}`,
        provider: "github",
        nonce: "z".repeat(128),
        codeChallenge: "c".repeat(256),
        codeChallengeMethod: "S256",
        scope: "openid profile email",
      });
      const signed = await signCookie(payload, SECRET);
      const result = await verifyCookie(signed, SECRET);
      expect(result).toBe(payload);
    });
  });
});
