import { describe, it, expect } from "vite-plus/test";
import {
  parseAllowedScopes,
  parseAllowedSubjects,
  isSubjectAllowedForResource,
  resolveEffectiveScope,
  resolveResourceScope,
  resolveResourceScopeOrDefault,
  validateNonce,
  validateCodeChallenge,
} from "./scopes";

describe("resolveResourceScope", () => {
  const resourceScopes = '["events:read","events:subscribe","requests:read","requests:update"]';

  it("リソースの許可スコープ内ならそのまま返す", () => {
    expect(resolveResourceScope("events:read events:subscribe", resourceScopes)).toBe(
      "events:read events:subscribe",
    );
  });

  it("リソースの許可外スコープは除外される", () => {
    expect(resolveResourceScope("events:read profile", resourceScopes)).toBe("events:read");
  });

  it("有効なスコープが残らなければ undefined", () => {
    expect(resolveResourceScope("profile email", resourceScopes)).toBeUndefined();
  });

  it("スコープ未指定では resource スコープを付与しない（全スコープ既定付与の廃止）", () => {
    expect(resolveResourceScope(undefined, resourceScopes)).toBeUndefined();
    expect(resolveResourceScope(null, resourceScopes)).toBeUndefined();
    expect(resolveResourceScope("", resourceScopes)).toBeUndefined();
    expect(resolveResourceScope("   ", resourceScopes)).toBeUndefined();
  });

  it("リソースの許可スコープが空なら undefined（フェイルクローズド）", () => {
    expect(resolveResourceScope("events:read", "[]")).toBeUndefined();
    expect(resolveResourceScope(undefined, "[]")).toBeUndefined();
  });
});

describe("resolveResourceScopeOrDefault", () => {
  const resourceScopes = '["events:read","events:subscribe","requests:read","requests:update"]';
  const allScopes = "events:read events:subscribe requests:read requests:update";

  it("OIDC スコープのみのリクエストでは許可スコープをすべて付与する（ChatGPT の実挙動）", () => {
    expect(resolveResourceScopeOrDefault("openid email profile", resourceScopes)).toBe(allScopes);
    expect(resolveResourceScopeOrDefault("openid", resourceScopes)).toBe(allScopes);
  });

  it("スコープ未指定・空では許可スコープをすべて付与する", () => {
    expect(resolveResourceScopeOrDefault(undefined, resourceScopes)).toBe(allScopes);
    expect(resolveResourceScopeOrDefault(null, resourceScopes)).toBe(allScopes);
    expect(resolveResourceScopeOrDefault("", resourceScopes)).toBe(allScopes);
    expect(resolveResourceScopeOrDefault("   ", resourceScopes)).toBe(allScopes);
  });

  it("リソース用スコープが含まれていれば厳密な絞り込み結果を使う", () => {
    expect(resolveResourceScopeOrDefault("events:read events:subscribe", resourceScopes)).toBe(
      "events:read events:subscribe",
    );
    expect(resolveResourceScopeOrDefault("events:read profile", resourceScopes)).toBe(
      "events:read",
    );
  });

  it("許可外のリソース用スコープだけを要求した場合は undefined（既定付与しない）", () => {
    expect(resolveResourceScopeOrDefault("events:admin", resourceScopes)).toBeUndefined();
    expect(resolveResourceScopeOrDefault("openid events:admin", resourceScopes)).toBeUndefined();
  });

  it("リソースの許可スコープが空なら undefined（フェイルクローズド）", () => {
    expect(resolveResourceScopeOrDefault("openid email profile", "[]")).toBeUndefined();
    expect(resolveResourceScopeOrDefault(undefined, "[]")).toBeUndefined();
    expect(resolveResourceScopeOrDefault("events:read", "[]")).toBeUndefined();
  });
});

describe("parseAllowedSubjects", () => {
  it("JSON配列をパースする", () => {
    expect(parseAllowedSubjects('["user-1","user-2"]')).toEqual(["user-1", "user-2"]);
  });

  it("空配列は制限なしとして空配列を返す", () => {
    expect(parseAllowedSubjects("[]")).toEqual([]);
  });

  it("null / undefined は制限なしとして空配列を返す", () => {
    expect(parseAllowedSubjects(null)).toEqual([]);
    expect(parseAllowedSubjects(undefined)).toEqual([]);
  });

  it("不正な値は null を返す（フェイルクローズド判定用）", () => {
    expect(parseAllowedSubjects("invalid")).toBeNull();
    expect(parseAllowedSubjects('"user-1"')).toBeNull();
    expect(parseAllowedSubjects('["user-1", 42]')).toBeNull();
    expect(parseAllowedSubjects('[""]')).toBeNull();
  });
});

describe("isSubjectAllowedForResource", () => {
  it("allowed_subjects が空なら全ユーザーを許可する", () => {
    expect(isSubjectAllowedForResource({ allowed_subjects: "[]" }, "user-9")).toBe(true);
    expect(isSubjectAllowedForResource({ allowed_subjects: null }, "user-9")).toBe(true);
    expect(isSubjectAllowedForResource({}, "user-9")).toBe(true);
  });

  it("制限付き resource では許可された subject のみ通す", () => {
    const resource = { allowed_subjects: '["user-1","user-2"]' };
    expect(isSubjectAllowedForResource(resource, "user-1")).toBe(true);
    expect(isSubjectAllowedForResource(resource, "user-2")).toBe(true);
    expect(isSubjectAllowedForResource(resource, "user-3")).toBe(false);
  });

  it("壊れた allowed_subjects はフェイルクローズド（誰も許可しない）", () => {
    expect(isSubjectAllowedForResource({ allowed_subjects: "not-json" }, "user-1")).toBe(false);
    expect(isSubjectAllowedForResource({ allowed_subjects: '["user-1", 42]' }, "user-1")).toBe(
      false,
    );
  });
});

describe("parseAllowedScopes", () => {
  it("JSON配列を正しくパースする", () => {
    expect(parseAllowedScopes('["profile","email"]')).toEqual(["profile", "email"]);
  });

  it("空配列をパースする", () => {
    expect(parseAllowedScopes("[]")).toEqual([]);
  });

  it("不正なJSONの場合は空配列を返す（フェイルクローズド）", () => {
    expect(parseAllowedScopes("invalid")).toEqual([]);
  });

  it("配列でない値の場合は空配列を返す（フェイルクローズド）", () => {
    expect(parseAllowedScopes('"profile"')).toEqual([]);
    expect(parseAllowedScopes("42")).toEqual([]);
  });

  it("スペースを含むスコープが除外される", () => {
    // "in valid" も "also valid" もスペースを含むため除外される
    expect(parseAllowedScopes('["valid", "in valid", "also valid"]')).toEqual(["valid"]);
  });

  it("制御文字を含むスコープが除外される", () => {
    // JSON内でUnicodeエスケープ（\\u0000）を使うことで制御文字を含む文字列を正しくパースさせる
    expect(parseAllowedScopes('["valid", "in\\u0000valid", "also\\u001Fvalid"]')).toEqual([
      "valid",
    ]);
  });

  it("有効なスコープ（read:users, profile.read, my-scope）が残る", () => {
    expect(parseAllowedScopes('["read:users","profile.read","my-scope"]')).toEqual([
      "read:users",
      "profile.read",
      "my-scope",
    ]);
  });
});

describe("resolveEffectiveScope", () => {
  const allowedScopesJson = '["profile","email","phone"]';

  describe("requestedScope が指定されている場合", () => {
    it("許可スコープに含まれるスコープのみ返す", () => {
      expect(resolveEffectiveScope("openid profile", allowedScopesJson)).toBe("openid profile");
    });

    it("許可されていないスコープはフィルタリングされる", () => {
      expect(resolveEffectiveScope("openid address", allowedScopesJson)).toBe("openid");
    });

    it("openid は allowed_scopes に含まれなくても常に許可される", () => {
      expect(resolveEffectiveScope("openid", "[]")).toBe("openid");
    });

    it("全スコープが無効な場合は undefined を返す", () => {
      expect(resolveEffectiveScope("address", allowedScopesJson)).toBeUndefined();
    });

    it("複数の許可スコープを正しく処理する", () => {
      expect(resolveEffectiveScope("openid profile email", allowedScopesJson)).toBe(
        "openid profile email",
      );
    });
  });

  describe("requestedScope が未指定の場合（最小スコープポリシー RFC 6749 §3.3）", () => {
    it("null の場合は openid のみを返す", () => {
      expect(resolveEffectiveScope(null, allowedScopesJson)).toBe("openid");
    });

    it("undefined の場合は openid のみを返す", () => {
      expect(resolveEffectiveScope(undefined, allowedScopesJson)).toBe("openid");
    });

    it("空文字の場合は openid のみを返す", () => {
      expect(resolveEffectiveScope("", allowedScopesJson)).toBe("openid");
    });

    it("allowed_scopes が空でも openid のみを返す（全スコープを付与しない）", () => {
      expect(resolveEffectiveScope(null, "[]")).toBe("openid");
    });

    it("allowed_scopes が多数あっても openid のみを返す（最小スコープ保証）", () => {
      const manyScopes = '["profile","email","phone","address","custom1","custom2"]';
      expect(resolveEffectiveScope(null, manyScopes)).toBe("openid");
    });
  });
});

describe("validateNonce", () => {
  it("undefined の場合は null を返す", () => {
    expect(validateNonce(undefined)).toBeNull();
  });

  it("正常な nonce の場合は null を返す", () => {
    expect(validateNonce("abc123XYZ")).toBeNull();
    expect(validateNonce("a".repeat(128))).toBeNull();
  });

  it("129文字の nonce はエラーメッセージを返す", () => {
    expect(validateNonce("a".repeat(129))).toBe("nonce too long");
  });

  it("制御文字を含む nonce はエラーメッセージを返す", () => {
    expect(validateNonce("nonce\x00value")).toBe("nonce contains invalid characters");
    expect(validateNonce("nonce\x1Fvalue")).toBe("nonce contains invalid characters");
    expect(validateNonce("nonce\x7Fvalue")).toBe("nonce contains invalid characters");
  });
});

describe("validateCodeChallenge", () => {
  it("undefined の場合は null を返す", () => {
    expect(validateCodeChallenge(undefined)).toBeNull();
  });

  it("正常な43文字のBASE64URL code_challenge は null を返す", () => {
    const valid = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(validateCodeChallenge(valid)).toBeNull();
  });

  it("42文字の code_challenge はエラーメッセージを返す", () => {
    const tooShort = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-c";
    expect(validateCodeChallenge(tooShort)).toBe("Invalid code_challenge format for S256");
  });

  it("44文字の code_challenge はエラーメッセージを返す", () => {
    const tooLong = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cMX";
    expect(validateCodeChallenge(tooLong)).toBe("Invalid code_challenge format for S256");
  });

  it("BASE64URLに不正な文字（+, /, =）を含む場合はエラーメッセージを返す", () => {
    // BASE64標準文字（+/=）はBASE64URLでは無効
    const withPlus = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw+cM";
    const withSlash = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw/cM";
    const withPadding = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw=cM";
    expect(validateCodeChallenge(withPlus)).toBe("Invalid code_challenge format for S256");
    expect(validateCodeChallenge(withSlash)).toBe("Invalid code_challenge format for S256");
    expect(validateCodeChallenge(withPadding)).toBe("Invalid code_challenge format for S256");
  });

  it("空文字はエラーメッセージを返す", () => {
    expect(validateCodeChallenge("")).toBe("Invalid code_challenge format for S256");
  });
});
