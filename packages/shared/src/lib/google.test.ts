import { describe, it, expect } from 'vitest';
import { normalizeRedirectUri, buildGoogleAuthUrl } from './google';

describe('normalizeRedirectUri', () => {
  it('有効なHTTPS URLはそのまま返す', () => {
    const result = normalizeRedirectUri('https://example.com/callback');
    expect(result).toBe('https://example.com/callback');
  });

  it('ホスト名を小文字化する', () => {
    const result = normalizeRedirectUri('https://EXAMPLE.COM/callback');
    expect(result).toBe('https://example.com/callback');
  });

  it('デフォルトポート443（HTTPS）を除去する', () => {
    const result = normalizeRedirectUri('https://example.com:443/callback');
    expect(result).toBe('https://example.com/callback');
  });

  it('デフォルトポート80（HTTP）を除去する', () => {
    const result = normalizeRedirectUri('http://localhost:80/callback');
    expect(result).toBe('http://localhost/callback');
  });

  it('非デフォルトポートは保持する', () => {
    const result = normalizeRedirectUri('https://example.com:8443/callback');
    expect(result).toBe('https://example.com:8443/callback');
  });

  it('HTTP localhostは許可', () => {
    const result = normalizeRedirectUri('http://localhost:3000/callback');
    expect(result).toBe('http://localhost:3000/callback');
  });

  it('HTTP 127.0.0.1は許可', () => {
    const result = normalizeRedirectUri('http://127.0.0.1:3000/callback');
    expect(result).toBe('http://127.0.0.1:3000/callback');
  });

  it('HTTP非localhostはnullを返す', () => {
    expect(normalizeRedirectUri('http://example.com/callback')).toBeNull();
    expect(normalizeRedirectUri('http://sub.example.com/callback')).toBeNull();
  });

  it('fragmentを含むURLはnullを返す', () => {
    expect(normalizeRedirectUri('https://example.com/callback#fragment')).toBeNull();
    expect(normalizeRedirectUri('https://example.com/#')).toBeNull();
  });

  it('無効なURLはnullを返す', () => {
    expect(normalizeRedirectUri('not-a-url')).toBeNull();
    expect(normalizeRedirectUri('')).toBeNull();
    expect(normalizeRedirectUri('javascript:alert(1)')).toBeNull();
  });

  it('クエリパラメータは保持する', () => {
    const result = normalizeRedirectUri('https://example.com/callback?foo=bar');
    expect(result).toBe('https://example.com/callback?foo=bar');
  });

  it('パスは保持する', () => {
    const result = normalizeRedirectUri('https://example.com/app/oauth/callback');
    expect(result).toBe('https://example.com/app/oauth/callback');
  });

  it('localhostポートなしも許可', () => {
    const result = normalizeRedirectUri('http://localhost/callback');
    expect(result).toBe('http://localhost/callback');
  });
});

describe('buildGoogleAuthUrl', () => {
  it('必要なパラメータを含む認可URLを生成する', () => {
    const url = buildGoogleAuthUrl({
      clientId: 'test-client-id',
      redirectUri: 'https://example.com/callback',
      state: 'test-state',
      codeChallenge: 'test-challenge',
    });

    const parsed = new URL(url);
    expect(parsed.hostname).toBe('accounts.google.com');
    expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    expect(parsed.searchParams.get('state')).toBe('test-state');
    expect(parsed.searchParams.get('code_challenge')).toBe('test-challenge');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('response_type')).toBe('code');
  });

  it('デフォルトスコープはopenid email profile', () => {
    const url = buildGoogleAuthUrl({
      clientId: 'id',
      redirectUri: 'https://example.com/cb',
      state: 'state',
      codeChallenge: 'challenge',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toBe('openid email profile');
  });

  it('カスタムスコープを指定できる', () => {
    const url = buildGoogleAuthUrl({
      clientId: 'id',
      redirectUri: 'https://example.com/cb',
      state: 'state',
      codeChallenge: 'challenge',
      scope: 'openid email',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toBe('openid email');
  });

  it('access_type=onlineが設定される', () => {
    const url = buildGoogleAuthUrl({
      clientId: 'id',
      redirectUri: 'https://example.com/cb',
      state: 'state',
      codeChallenge: 'challenge',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('access_type')).toBe('online');
  });
});
