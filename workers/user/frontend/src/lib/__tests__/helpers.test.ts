import { describe, expect, it } from "vite-plus/test";
import { escapeHtml, formatUnixSec, getInitials, truncate } from "../../lib/helpers";

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes less-than", () => {
    expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
  });

  it("escapes greater-than", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it("escapes double quote", () => {
    expect(escapeHtml('a"b')).toBe("a&quot;b");
  });

  it("escapes single quote", () => {
    expect(escapeHtml("a'b")).toBe("a&#39;b");
  });

  it("returns string unchanged when no special chars", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes multiple special chars", () => {
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });
});

describe("truncate", () => {
  it("returns original when shorter than max", () => {
    expect(truncate("abc", 5)).toBe("abc");
  });

  it("returns original when equal to max", () => {
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  it("truncates and adds ellipsis when longer than max", () => {
    expect(truncate("abcdef", 5)).toBe("abcde…");
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });
});

describe("getInitials", () => {
  it("returns first letters of multi-word name", () => {
    expect(getInitials("John Doe", "john@example.com")).toBe("JD");
  });

  it("returns first letter of single-word name", () => {
    expect(getInitials("Alice", "alice@example.com")).toBe("A");
  });

  it("truncates to 2 chars for long names", () => {
    expect(getInitials("A B C D", "x@y.com")).toBe("AB");
  });

  it("falls back to email initial when name is null", () => {
    expect(getInitials(null, "bob@example.com")).toBe("B");
  });

  it("falls back to email initial when name is undefined", () => {
    expect(getInitials(undefined, "carol@example.com")).toBe("C");
  });

  it("falls back to email initial when name is empty string", () => {
    expect(getInitials("", "dave@example.com")).toBe("D");
  });

  it("returns ? when no name and no email", () => {
    expect(getInitials(null, "")).toBe("?");
  });
});

describe("formatUnixSec", () => {
  it("converts unix seconds to formatted datetime string", () => {
    // 2024-01-15T09:30:00Z = 1705308600
    const result = formatUnixSec(1705308600);
    // Should contain date parts (locale-dependent but ja-JP format)
    expect(result).toContain("2024");
    expect(result).toContain("01");
    expect(result).toContain("15");
  });
});
