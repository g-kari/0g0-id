import { describe, it, expect } from "vite-plus/test";
import { escapeHtml, truncate, getInitials } from "./helpers";

describe("escapeHtml", () => {
  it("& をエスケープする", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("< と > をエスケープする", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("ダブルクォートをエスケープする", () => {
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("シングルクォートをエスケープする", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("複数の特殊文字を同時にエスケープする", () => {
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });

  it("特殊文字がなければそのまま返す", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("空文字はそのまま返す", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("truncate", () => {
  it("max 以下の文字列はそのまま返す", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("max と同じ長さはそのまま返す", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("max を超える文字列は切り詰めて … を付ける", () => {
    expect(truncate("hello world", 5)).toBe("hello\u2026");
  });

  it("max=0 の場合は … のみ", () => {
    expect(truncate("hello", 0)).toBe("\u2026");
  });
});

describe("getInitials", () => {
  it("名前からイニシャルを取得する", () => {
    expect(getInitials("John Doe", "john@example.com")).toBe("JD");
  });

  it("3単語以上でも最大2文字", () => {
    expect(getInitials("John Michael Doe", "j@example.com")).toBe("JM");
  });

  it("1単語の名前は1文字", () => {
    expect(getInitials("John", "john@example.com")).toBe("J");
  });

  it("名前が null の場合は email の先頭文字", () => {
    expect(getInitials(null, "john@example.com")).toBe("J");
  });

  it("名前が undefined の場合は email の先頭文字", () => {
    expect(getInitials(undefined, "john@example.com")).toBe("J");
  });

  it("名前が空文字の場合は email の先頭文字", () => {
    expect(getInitials("", "john@example.com")).toBe("J");
  });

  it("email も空の場合は ? を返す", () => {
    expect(getInitials(null, "")).toBe("?");
  });
});
