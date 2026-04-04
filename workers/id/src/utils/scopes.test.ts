import { describe, it, expect } from 'vitest';
import { parseAllowedScopes, resolveEffectiveScope } from './scopes';

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
