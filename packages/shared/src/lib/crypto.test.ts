import { describe, it, expect } from 'vitest';
import {
  generateToken,
  generateClientId,
  generateClientSecret,
  sha256,
  timingSafeEqual,
  generateCodeVerifier,
  generateCodeChallenge,
} from './crypto';

describe('generateToken', () => {
  it('URLセーフな文字のみを含む', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('デフォルトで32バイト相当の長さ', () => {
    const token = generateToken();
    // 32バイト → base64url で43文字（パディングなし）
    expect(token.length).toBeGreaterThanOrEqual(42);
  });

  it('指定バイト長で生成できる', () => {
    const short = generateToken(8);
    const long = generateToken(64);
    expect(short.length).toBeLessThan(long.length);
  });

  it('毎回異なる値を生成する', () => {
    const t1 = generateToken();
    const t2 = generateToken();
    expect(t1).not.toBe(t2);
  });

  it('+、/、= を含まない（URLセーフ）', () => {
    for (let i = 0; i < 20; i++) {
      const token = generateToken();
      expect(token).not.toContain('+');
      expect(token).not.toContain('/');
      expect(token).not.toContain('=');
    }
  });
});

describe('generateClientId', () => {
  it('16バイトのhex文字列（32文字）', () => {
    const id = generateClientId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('毎回異なる値を生成する', () => {
    expect(generateClientId()).not.toBe(generateClientId());
  });
});

describe('generateClientSecret', () => {
  it('32バイトのhex文字列（64文字）', () => {
    const secret = generateClientSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('毎回異なる値を生成する', () => {
    expect(generateClientSecret()).not.toBe(generateClientSecret());
  });
});

describe('sha256', () => {
  it('既知の入力に対して正しいハッシュを返す', async () => {
    // echo -n "hello" | sha256sum
    const hash = await sha256('hello');
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('空文字列のハッシュ', async () => {
    const hash = await sha256('');
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('同じ入力は常に同じハッシュ', async () => {
    const h1 = await sha256('test-input');
    const h2 = await sha256('test-input');
    expect(h1).toBe(h2);
  });

  it('異なる入力は異なるハッシュ', async () => {
    const h1 = await sha256('aaa');
    const h2 = await sha256('bbb');
    expect(h1).not.toBe(h2);
  });

  it('16進数文字列を返す', async () => {
    const hash = await sha256('test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('timingSafeEqual', () => {
  it('同じ文字列はtrue', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('異なる文字列はfalse', () => {
    expect(timingSafeEqual('abc', 'xyz')).toBe(false);
  });

  it('長さが異なる場合はfalse', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('abcd', 'abc')).toBe(false);
  });

  it('空文字列同士はtrue', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('一方が空文字列の場合はfalse', () => {
    expect(timingSafeEqual('', 'a')).toBe(false);
    expect(timingSafeEqual('a', '')).toBe(false);
  });

  it('先頭だけ一致する場合はfalse', () => {
    expect(timingSafeEqual('abcdef', 'abcxyz')).toBe(false);
  });
});

describe('generateCodeVerifier / generateCodeChallenge', () => {
  it('code_verifierはURLセーフ文字のみ', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('code_challengeはURLセーフbase64', async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('S256方式: base64url(sha256(verifier)) === challenge', async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);

    const data = new TextEncoder().encode(verifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const expected = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    expect(challenge).toBe(expected);
  });

  it('同じverifierから常に同じchallengeが生成される', async () => {
    const verifier = generateCodeVerifier();
    const c1 = await generateCodeChallenge(verifier);
    const c2 = await generateCodeChallenge(verifier);
    expect(c1).toBe(c2);
  });

  it('異なるverifierから異なるchallengeが生成される', async () => {
    const v1 = generateCodeVerifier();
    const v2 = generateCodeVerifier();
    const c1 = await generateCodeChallenge(v1);
    const c2 = await generateCodeChallenge(v2);
    expect(c1).not.toBe(c2);
  });
});
