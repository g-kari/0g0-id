import { describe, it, expect } from 'vitest';
import { matchRedirectUri } from './redirect-uri';

describe('matchRedirectUri', () => {
  it('localhost: ポートが異なっても一致する (RFC 8252 §7.3)', () => {
    expect(matchRedirectUri('http://localhost/callback', 'http://localhost:51234/callback')).toBe(true);
  });

  it('localhost: ポートなし同士で一致する', () => {
    expect(matchRedirectUri('http://localhost/callback', 'http://localhost/callback')).toBe(true);
  });

  it('localhost: パスが異なる場合は不一致', () => {
    expect(matchRedirectUri('http://localhost/callback', 'http://localhost:51234/other')).toBe(false);
  });

  it('localhost: クエリストリングが異なる場合は不一致', () => {
    expect(matchRedirectUri('http://localhost/callback?foo=bar', 'http://localhost:51234/callback?foo=baz')).toBe(false);
  });

  it('localhost: クエリストリングが一致する場合は一致', () => {
    expect(matchRedirectUri('http://localhost/callback?foo=bar', 'http://localhost:51234/callback?foo=bar')).toBe(true);
  });

  it('127.0.0.1: ポートが異なっても一致する', () => {
    expect(matchRedirectUri('http://127.0.0.1/callback', 'http://127.0.0.1:8080/callback')).toBe(true);
  });

  it('localhost と 127.0.0.1 は同一ホストとして扱う (RFC 8252 §8.3)', () => {
    expect(matchRedirectUri('http://localhost/callback', 'http://127.0.0.1:8080/callback')).toBe(true);
  });

  it('127.0.0.1 と localhost は同一ホストとして扱う (RFC 8252 §8.3)', () => {
    expect(matchRedirectUri('http://127.0.0.1/callback', 'http://localhost:8080/callback')).toBe(true);
  });

  it('非localhost: 完全一致が必要', () => {
    expect(matchRedirectUri('https://example.com/callback', 'https://example.com/callback')).toBe(true);
  });

  it('非localhost: ポートが異なる場合は不一致', () => {
    expect(matchRedirectUri('https://example.com/callback', 'https://example.com:8080/callback')).toBe(false);
  });

  it('不正なURLは不一致', () => {
    expect(matchRedirectUri('not-a-url', 'http://localhost/callback')).toBe(false);
  });

  it('プロトコルが異なる場合は不一致', () => {
    expect(matchRedirectUri('https://localhost/callback', 'http://localhost:8080/callback')).toBe(false);
  });
});
