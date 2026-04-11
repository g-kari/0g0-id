import { describe, it, expect } from "vite-plus/test";
import { UUID_RE } from "./validation";

describe("UUID_RE", () => {
  it("有効なUUID v4形式にマッチする", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("大文字の16進数にもマッチする（大文字小文字区別なし）", () => {
    expect(UUID_RE.test("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("混合ケースにもマッチする", () => {
    expect(UUID_RE.test("550e8400-E29b-41D4-a716-446655440000")).toBe(true);
  });

  it("全ゼロのUUIDにマッチする", () => {
    expect(UUID_RE.test("00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  it("全fのUUIDにマッチする", () => {
    expect(UUID_RE.test("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(true);
  });

  it("ハイフンなしの形式にはマッチしない", () => {
    expect(UUID_RE.test("550e8400e29b41d4a716446655440000")).toBe(false);
  });

  it("短すぎる文字列にはマッチしない", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-44665544000")).toBe(false);
  });

  it("長すぎる文字列にはマッチしない", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-4466554400000")).toBe(false);
  });

  it("空文字にはマッチしない", () => {
    expect(UUID_RE.test("")).toBe(false);
  });

  it("無効な16進数文字を含む場合はマッチしない", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-44665544000g")).toBe(false);
  });

  it("ハイフン位置が違う場合はマッチしない", () => {
    expect(UUID_RE.test("550e840-0e29b-41d4-a716-446655440000")).toBe(false);
  });

  it("プレフィックス付きの文字列にはマッチしない（先頭一致が必須）", () => {
    expect(UUID_RE.test("prefix-550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });

  it("サフィックス付きの文字列にはマッチしない（末尾一致が必須）", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000-suffix")).toBe(false);
  });
});
