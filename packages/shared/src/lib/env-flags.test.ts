import { describe, it, expect } from "vite-plus/test";
import { parseStrictBoolEnv } from "./env-flags";

describe("parseStrictBoolEnv", () => {
  it('"true" → true', () => {
    expect(parseStrictBoolEnv("true")).toBe(true);
  });

  it('"TRUE" → true（大文字）', () => {
    expect(parseStrictBoolEnv("TRUE")).toBe(true);
  });

  it('"True" → true（混合ケース）', () => {
    expect(parseStrictBoolEnv("True")).toBe(true);
  });

  it('" true " → true（前後スペース）', () => {
    expect(parseStrictBoolEnv(" true ")).toBe(true);
  });

  it('"\\ttrue\\n" → true（タブ・改行）', () => {
    expect(parseStrictBoolEnv("\ttrue\n")).toBe(true);
  });

  it('"false" → false', () => {
    expect(parseStrictBoolEnv("false")).toBe(false);
  });

  it('"1" → false（受理しない）', () => {
    expect(parseStrictBoolEnv("1")).toBe(false);
  });

  it('"yes" → false（受理しない）', () => {
    expect(parseStrictBoolEnv("yes")).toBe(false);
  });

  it('"on" → false（受理しない）', () => {
    expect(parseStrictBoolEnv("on")).toBe(false);
  });

  it("空文字 → false", () => {
    expect(parseStrictBoolEnv("")).toBe(false);
  });

  it("undefined → false", () => {
    expect(parseStrictBoolEnv(undefined)).toBe(false);
  });

  it("null → false", () => {
    expect(parseStrictBoolEnv(null)).toBe(false);
  });
});
