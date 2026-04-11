import { describe, expect, it } from "vite-plus/test";
import { escapeLikePattern } from "./sql";

describe("escapeLikePattern", () => {
  it("通常の文字列はそのまま返す", () => {
    expect(escapeLikePattern("hello")).toBe("hello");
  });

  it("% をエスケープする", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
  });

  it("_ をエスケープする", () => {
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
  });

  it("\\ をエスケープする", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("複数のワイルドカード文字を同時にエスケープする", () => {
    expect(escapeLikePattern("%_test_%")).toBe("\\%\\_test\\_\\%");
  });

  it("空文字列はそのまま返す", () => {
    expect(escapeLikePattern("")).toBe("");
  });
});
