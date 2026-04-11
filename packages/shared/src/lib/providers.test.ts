import { describe, it, expect } from "vite-plus/test";
import {
  ALL_PROVIDERS,
  isValidProvider,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_COLUMN,
  PROVIDER_CREDENTIALS,
  type OAuthProvider,
} from "./providers";

describe("ALL_PROVIDERS", () => {
  it("5種類のプロバイダーを含む", () => {
    expect(ALL_PROVIDERS).toHaveLength(5);
  });

  it("google/line/twitch/github/xを含む", () => {
    expect(ALL_PROVIDERS).toContain("google");
    expect(ALL_PROVIDERS).toContain("line");
    expect(ALL_PROVIDERS).toContain("twitch");
    expect(ALL_PROVIDERS).toContain("github");
    expect(ALL_PROVIDERS).toContain("x");
  });
});

describe("isValidProvider", () => {
  it("有効なプロバイダー名をtrueと判定する", () => {
    const valid: string[] = ["google", "line", "twitch", "github", "x"];
    for (const p of valid) {
      expect(isValidProvider(p)).toBe(true);
    }
  });

  it("無効なプロバイダー名をfalseと判定する", () => {
    expect(isValidProvider("facebook")).toBe(false);
    expect(isValidProvider("twitter")).toBe(false);
    expect(isValidProvider("")).toBe(false);
    expect(isValidProvider("Google")).toBe(false); // 大文字はNG
    expect(isValidProvider("LINE")).toBe(false);
  });

  it("型ガードとして機能する", () => {
    const value: string = "google";
    if (isValidProvider(value)) {
      const provider: OAuthProvider = value; // 型エラーが出なければOK
      expect(provider).toBe("google");
    }
  });
});

describe("PROVIDER_DISPLAY_NAMES", () => {
  it("全プロバイダーの表示名が定義されている", () => {
    for (const provider of ALL_PROVIDERS) {
      expect(PROVIDER_DISPLAY_NAMES[provider]).toBeTruthy();
    }
  });

  it("各プロバイダーの表示名が正しい", () => {
    expect(PROVIDER_DISPLAY_NAMES.google).toBe("Google");
    expect(PROVIDER_DISPLAY_NAMES.line).toBe("LINE");
    expect(PROVIDER_DISPLAY_NAMES.twitch).toBe("Twitch");
    expect(PROVIDER_DISPLAY_NAMES.github).toBe("GitHub");
    expect(PROVIDER_DISPLAY_NAMES.x).toBe("X");
  });
});

describe("PROVIDER_COLUMN", () => {
  it("全プロバイダーのDBカラム名が定義されている", () => {
    for (const provider of ALL_PROVIDERS) {
      expect(PROVIDER_COLUMN[provider]).toBeTruthy();
    }
  });

  it("各プロバイダーのDBカラム名が正しい", () => {
    expect(PROVIDER_COLUMN.google).toBe("google_sub");
    expect(PROVIDER_COLUMN.line).toBe("line_sub");
    expect(PROVIDER_COLUMN.twitch).toBe("twitch_sub");
    expect(PROVIDER_COLUMN.github).toBe("github_sub");
    expect(PROVIDER_COLUMN.x).toBe("x_sub");
  });

  it("カラム名は_sub接尾辞を持つ", () => {
    for (const provider of ALL_PROVIDERS) {
      expect(PROVIDER_COLUMN[provider]).toMatch(/_sub$/);
    }
  });
});

describe("PROVIDER_CREDENTIALS", () => {
  it("googleを除く4プロバイダーが定義されている", () => {
    expect(Object.keys(PROVIDER_CREDENTIALS)).toHaveLength(4);
    expect(Object.keys(PROVIDER_CREDENTIALS)).not.toContain("google");
  });

  it("各プロバイダーにid/secret/nameフィールドがある", () => {
    const providers = ["line", "twitch", "github", "x"] as const;
    for (const provider of providers) {
      const creds = PROVIDER_CREDENTIALS[provider];
      expect(creds.id).toBeTruthy();
      expect(creds.secret).toBeTruthy();
      expect(creds.name).toBeTruthy();
    }
  });

  it("各プロバイダーのクレデンシャル環境変数名が正しい", () => {
    expect(PROVIDER_CREDENTIALS.line.id).toBe("LINE_CLIENT_ID");
    expect(PROVIDER_CREDENTIALS.line.secret).toBe("LINE_CLIENT_SECRET");
    expect(PROVIDER_CREDENTIALS.github.id).toBe("GITHUB_CLIENT_ID");
    expect(PROVIDER_CREDENTIALS.github.secret).toBe("GITHUB_CLIENT_SECRET");
    expect(PROVIDER_CREDENTIALS.x.id).toBe("X_CLIENT_ID");
    expect(PROVIDER_CREDENTIALS.x.secret).toBe("X_CLIENT_SECRET");
    expect(PROVIDER_CREDENTIALS.twitch.id).toBe("TWITCH_CLIENT_ID");
    expect(PROVIDER_CREDENTIALS.twitch.secret).toBe("TWITCH_CLIENT_SECRET");
  });

  it("表示名（name）が正しい", () => {
    expect(PROVIDER_CREDENTIALS.line.name).toBe("LINE");
    expect(PROVIDER_CREDENTIALS.github.name).toBe("GitHub");
    expect(PROVIDER_CREDENTIALS.x.name).toBe("X");
    expect(PROVIDER_CREDENTIALS.twitch.name).toBe("Twitch");
  });
});
