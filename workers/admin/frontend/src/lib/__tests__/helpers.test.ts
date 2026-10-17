import { describe, it, expect } from "vite-plus/test";
import { escapeHtml, truncate } from "../../lib/helpers";

describe("escapeHtml", () => {
  it("escapes & character", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes < character", () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });

  it("escapes > character", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it('escapes " character', () => {
    expect(escapeHtml('a"b')).toBe("a&quot;b");
  });

  it("escapes ' character", () => {
    expect(escapeHtml("a'b")).toBe("a&#39;b");
  });

  it("escapes all special chars in one string", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("returns string unchanged when no special chars", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("truncate", () => {
  it("returns string unchanged when shorter than n", () => {
    expect(truncate("abc", 5)).toBe("abc");
  });

  it("returns string unchanged when equal to n", () => {
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  it("truncates and adds ellipsis when longer than n", () => {
    expect(truncate("abcdef", 5)).toBe("abcde\u2026");
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });
});
