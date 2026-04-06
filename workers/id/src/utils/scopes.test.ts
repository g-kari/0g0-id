import { describe, it, expect } from 'vitest';
import { parseAllowedScopes, resolveEffectiveScope, validateNonce } from './scopes';

describe('parseAllowedScopes', () => {
  it('JSON配列を正しくパースする', () => {
    expect(parseAllowedScopes('["profile","email"]')).toEqual(['profile', 'email']);
  });

  it('空配列をパースする', () => {
    expect(parseAllowedScopes('[]')).toEqual([]);
  });

  it('不正なJSONの場合は空配列を返す（フェイルクローズド）', () => {
    expect(parseAllowedScopes('invalid')).toEqual([]);
  });

  it('配列でない値の場合は空配列を返す（フェイルクローズド）', () => {
    expect(parseAllowedScopes('"profile"')).toEqual([]);
    expect(parseAllowedScopes('42')).toEqual([]);
  });

  it('スペースを含むスコープが除外される', () => {
    // "in valid" も "also valid" もスペースを含むため除外される
    expect(parseAllowedScopes('["valid", "in valid", "also valid"]')).toEqual(['valid']);
  });

  it('制御文字を含むスコープが除外される', () => {
    // JSON内でUnicodeエスケープ（\\u0000）を使うことで制御文字を含む文字列を正しくパースさせる
    expect(parseAllowedScopes('["valid", "in\\u0000valid", "also\\u001Fvalid"]')).toEqual(['valid']);
  });

  it('有効なスコープ（read:users, profile.read, my-scope）が残る', () => {
    expect(parseAllowedScopes('["read:users","profile.read","my-scope"]')).toEqual([
      'read:users',
      'profile.read',
      'my-scope',
    ]);
  });
});

describe('resolveEffectiveScope', () => {
  const allowedScopesJson = '["profile","email","phone"]';

  describe('requestedScope が指定されている場合', () => {
    it('許可スコープに含まれるスコープのみ返す', () => {
      expect(resolveEffectiveScope('openid profile', allowedScopesJson)).toBe('openid profile');
    });

    it('許可されていないスコープはフィルタリングされる', () => {
      expect(resolveEffectiveScope('openid address', allowedScopesJson)).toBe('openid');
    });

    it('openid は allowed_scopes に含まれなくても常に許可される', () => {
      expect(resolveEffectiveScope('openid', '[]')).toBe('openid');
    });

    it('全スコープが無効な場合は undefined を返す', () => {
      expect(resolveEffectiveScope('address', allowedScopesJson)).toBeUndefined();
    });

    it('複数の許可スコープを正しく処理する', () => {
      expect(resolveEffectiveScope('openid profile email', allowedScopesJson)).toBe(
        'openid profile email'
      );
    });
  });

  describe('requestedScope が未指定の場合（最小スコープポリシー RFC 6749 §3.3）', () => {
    it('null の場合は openid のみを返す', () => {
      expect(resolveEffectiveScope(null, allowedScopesJson)).toBe('openid');
    });

    it('undefined の場合は openid のみを返す', () => {
      expect(resolveEffectiveScope(undefined, allowedScopesJson)).toBe('openid');
    });

    it('空文字の場合は openid のみを返す', () => {
      expect(resolveEffectiveScope('', allowedScopesJson)).toBe('openid');
    });

    it('allowed_scopes が空でも openid のみを返す（全スコープを付与しない）', () => {
      expect(resolveEffectiveScope(null, '[]')).toBe('openid');
    });

    it('allowed_scopes が多数あっても openid のみを返す（最小スコープ保証）', () => {
      const manyScopes = '["profile","email","phone","address","custom1","custom2"]';
      expect(resolveEffectiveScope(null, manyScopes)).toBe('openid');
    });
  });
});

describe('validateNonce', () => {
  it('undefined の場合は null を返す', () => {
    expect(validateNonce(undefined)).toBeNull();
  });

  it('正常な nonce の場合は null を返す', () => {
    expect(validateNonce('abc123XYZ')).toBeNull();
    expect(validateNonce('a'.repeat(128))).toBeNull();
  });

  it('129文字の nonce はエラーメッセージを返す', () => {
    expect(validateNonce('a'.repeat(129))).toBe('nonce too long');
  });

  it('制御文字を含む nonce はエラーメッセージを返す', () => {
    expect(validateNonce('nonce\x00value')).toBe('nonce contains invalid characters');
    expect(validateNonce('nonce\x1Fvalue')).toBe('nonce contains invalid characters');
    expect(validateNonce('nonce\x7Fvalue')).toBe('nonce contains invalid characters');
  });
});
