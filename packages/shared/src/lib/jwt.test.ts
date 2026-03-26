import { describe, it, expect, beforeAll } from 'vitest';
import { signAccessToken, signIdToken, verifyAccessToken, getJWTKeys, getJWKS } from './jwt';
import { decodeBase64Url } from './base64url';

// テスト用 ES256 鍵ペア（固定値）
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgrZghEEi6BBGwfZOq
xDomoXNlA2LXvkC4tK5iqkDMrA+hRANCAARj8giy/uqZi4CF/nz5E3NzoFpAaLNx
JX+ypi6Oipzku2j0lTUIHLNtV9vVZX8kCaETTWLjaypsISdu9M8dKazX
-----END PRIVATE KEY-----`;

const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY/IIsv7qmYuAhf58+RNzc6BaQGiz
cSV/sqYujoqc5Lto9JU1CByzbVfb1WV/JAmhE01i42sqbCEnbvTPHSms1w==
-----END PUBLIC KEY-----`;

const basePayload = {
  iss: 'https://id.0g0.xyz',
  sub: 'user-id-123',
  aud: 'https://id.0g0.xyz',
  email: 'test@example.com',
  role: 'user' as const,
};

describe('getJWTKeys', () => {
  it('鍵ペアとkidを返す', async () => {
    const keys = await getJWTKeys(TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    expect(keys.privateKey).toBeDefined();
    expect(keys.publicKey).toBeDefined();
    expect(typeof keys.kid).toBe('string');
    expect(keys.kid.length).toBe(16);
  });

  it('kidは16文字の16進数文字列', async () => {
    const keys = await getJWTKeys(TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    expect(keys.kid).toMatch(/^[0-9a-f]{16}$/);
  });

  it('同じ鍵でも同じkidを返す（決定論的）', async () => {
    const keys1 = await getJWTKeys(TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    const keys2 = await getJWTKeys(TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    expect(keys1.kid).toBe(keys2.kid);
  });
});

describe('signAccessToken', () => {
  it('JWTトークン文字列を返す', async () => {
    const token = await signAccessToken(basePayload, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    expect(typeof token).toBe('string');
    // JWT は . で区切られた3パート
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
  });

  it('ヘッダーにES256アルゴリズムとkidが含まれる', async () => {
    const token = await signAccessToken(basePayload, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    const header = JSON.parse(decodeBase64Url(token.split('.')[0]));
    expect(header.alg).toBe('ES256');
    expect(typeof header.kid).toBe('string');
  });

  it('ペイロードにissuer・subject・audienceが含まれる', async () => {
    const token = await signAccessToken(basePayload, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    const raw = token.split('.')[1];
    const payload = JSON.parse(decodeBase64Url(raw));
    expect(payload.iss).toBe('https://id.0g0.xyz');
    expect(payload.sub).toBe('user-id-123');
    expect(payload.aud).toBe('https://id.0g0.xyz');
    expect(payload.email).toBe('test@example.com');
    expect(payload.role).toBe('user');
  });

  it('有効期限（exp）が設定される', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signAccessToken(basePayload, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    const raw = token.split('.')[1];
    const payload = JSON.parse(decodeBase64Url(raw));
    // 15分 = 900秒
    expect(payload.exp).toBeGreaterThan(before + 800);
    expect(payload.exp).toBeLessThan(before + 1000);
  });
});

describe('signIdToken', () => {
  const idPayload = {
    iss: 'https://id.0g0.xyz',
    sub: 'user-id-123',
    aud: 'https://id.0g0.xyz',
    email: 'test@example.com',
    name: 'Test User',
    picture: 'https://example.com/pic.jpg',
    authTime: Math.floor(Date.now() / 1000),
  };

  it('JWTトークン文字列を返す', async () => {
    const token = await signIdToken(idPayload, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    expect(typeof token).toBe('string');
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
  });

  it('ヘッダーにES256アルゴリズムとkidが含まれる', async () => {
    const token = await signIdToken(idPayload, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    const header = JSON.parse(decodeBase64Url(token.split('.')[0]));
    expect(header.alg).toBe('ES256');
    expect(typeof header.kid).toBe('string');
  });

  it('ペイロードにOIDC必須クレームが含まれる', async () => {
    const token = await signIdToken(idPayload, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    const raw = token.split('.')[1];
    const payload = JSON.parse(decodeBase64Url(raw));
    expect(payload.iss).toBe('https://id.0g0.xyz');
    expect(payload.sub).toBe('user-id-123');
    expect(payload.aud).toBe('https://id.0g0.xyz');
    expect(payload.email).toBe('test@example.com');
    expect(payload.name).toBe('Test User');
    expect(payload.picture).toBe('https://example.com/pic.jpg');
    expect(typeof payload.auth_time).toBe('number');
    expect(typeof payload.jti).toBe('string');
  });

  it('有効期限（exp）が1時間後に設定される', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signIdToken(idPayload, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    const raw = token.split('.')[1];
    const payload = JSON.parse(decodeBase64Url(raw));
    // 1時間 = 3600秒
    expect(payload.exp).toBeGreaterThan(before + 3500);
    expect(payload.exp).toBeLessThan(before + 3700);
  });

  it('pictureがnullの場合はpictureクレームを含まない', async () => {
    const token = await signIdToken(
      { ...idPayload, picture: null },
      TEST_PRIVATE_KEY,
      TEST_PUBLIC_KEY
    );
    const raw = token.split('.')[1];
    const payload = JSON.parse(decodeBase64Url(raw));
    expect(payload.picture).toBeUndefined();
  });
});

describe('verifyAccessToken', () => {
  let validToken: string;

  beforeAll(async () => {
    validToken = await signAccessToken(basePayload, TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
  });

  it('有効なトークンをデコードしてペイロードを返す', async () => {
    const payload = await verifyAccessToken(
      validToken,
      TEST_PUBLIC_KEY,
      'https://id.0g0.xyz',
      'https://id.0g0.xyz'
    );
    expect(payload.sub).toBe('user-id-123');
    expect(payload.email).toBe('test@example.com');
    expect(payload.role).toBe('user');
  });

  it('不正なトークンは例外を投げる', async () => {
    await expect(
      verifyAccessToken('invalid.token.here', TEST_PUBLIC_KEY, 'https://id.0g0.xyz', 'https://id.0g0.xyz')
    ).rejects.toThrow();
  });

  it('audience不一致は例外を投げる', async () => {
    await expect(
      verifyAccessToken(validToken, TEST_PUBLIC_KEY, 'https://wrong.aud', 'https://id.0g0.xyz')
    ).rejects.toThrow();
  });

  it('issuer不一致は例外を投げる', async () => {
    await expect(
      verifyAccessToken(validToken, TEST_PUBLIC_KEY, 'https://id.0g0.xyz', 'https://wrong.iss')
    ).rejects.toThrow();
  });
});

describe('getJWKS', () => {
  it('keysプロパティを持つJWKSオブジェクトを返す', async () => {
    const keys = await getJWTKeys(TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    const jwks = await getJWKS(TEST_PUBLIC_KEY, keys.kid) as { keys: unknown[] };
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys).toHaveLength(1);
  });

  it('JWKにkid・use・algが含まれる', async () => {
    const keys = await getJWTKeys(TEST_PRIVATE_KEY, TEST_PUBLIC_KEY);
    const jwks = await getJWKS(TEST_PUBLIC_KEY, keys.kid) as { keys: Record<string, string>[] };
    const key = jwks.keys[0];
    expect(key.kid).toBe(keys.kid);
    expect(key.use).toBe('sig');
    expect(key.alg).toBe('ES256');
    expect(key.kty).toBe('EC');
  });
});
