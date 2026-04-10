import { describe, it, expect } from 'vitest';
import { decodeBase64Url } from './base64url';

describe('decodeBase64Url', () => {
  it('通常の文字列をデコードできる', () => {
    // btoa('hello') = 'aGVsbG8='
    // base64url: 'aGVsbG8'
    expect(decodeBase64Url('aGVsbG8')).toBe('hello');
  });

  it('パディングあり（=）でもデコードできる', () => {
    expect(decodeBase64Url('aGVsbG8=')).toBe('hello');
  });

  it('+ の代わりに - を使うbase64url文字列をデコードできる', () => {
    // base64: 'fa+' → base64url: 'fa-'
    // '7da7' in base64url → decodes to binary
    const original = '\xfb\xda\xfb';
    const encoded = btoa(original).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    expect(decodeBase64Url(encoded)).toBe(original);
  });

  it('/ の代わりに _ を使うbase64url文字列をデコードできる', () => {
    const original = '\xff\xef\xbf';
    const encoded = btoa(original).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    expect(decodeBase64Url(encoded)).toBe(original);
  });

  it('空文字列をデコードできる', () => {
    expect(decodeBase64Url('')).toBe('');
  });

  it('JSONをエンコードしたbase64url文字列をデコードできる', () => {
    const payload = JSON.stringify({ sub: 'user-1', role: 'user' });
    const encoded = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    expect(decodeBase64Url(encoded)).toBe(payload);
  });

  it('パディングが1文字必要なケース（length % 4 === 3）', () => {
    // 'Man' → base64 = 'TWFu' (length=4, no padding needed)
    // 'Ma' → base64 = 'TWE=' (length=3 without padding)
    expect(decodeBase64Url('TWE')).toBe('Ma');
  });

  it('パディングが2文字必要なケース（length % 4 === 2）', () => {
    // 'M' → base64 = 'TQ==' (length=2 without padding)
    expect(decodeBase64Url('TQ')).toBe('M');
  });

  it('JWTのペイロード部分をデコードできる', () => {
    const payload = { sub: 'user-id', iss: 'https://id.0g0.xyz', iat: 1700000000 };
    const encoded = btoa(JSON.stringify(payload))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    const decoded = decodeBase64Url(encoded);
    expect(JSON.parse(decoded)).toEqual(payload);
  });
});
