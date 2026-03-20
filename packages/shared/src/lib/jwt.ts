import { SignJWT, jwtVerify, exportJWK, importPKCS8, importSPKI } from 'jose';
import type { TokenPayload } from '../types';

export interface JWTKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  kid: string;
}

/** PEM文字列をキーとしたキャッシュ（鍵ローテーション時にも正しく反映される） */
const keyCache = new Map<string, JWTKeys>();
const publicKeyCache = new Map<string, CryptoKey>();

async function getCachedPublicKey(publicKeyPem: string): Promise<CryptoKey> {
  const cached = publicKeyCache.get(publicKeyPem);
  if (cached) return cached;
  const key = await importSPKI(publicKeyPem, 'ES256');
  publicKeyCache.set(publicKeyPem, key);
  return key;
}

export async function getJWTKeys(privateKeyPem: string, publicKeyPem: string): Promise<JWTKeys> {
  const cacheKey = publicKeyPem;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const privateKey = await importPKCS8(privateKeyPem, 'ES256');
  const publicKey = await importSPKI(publicKeyPem, 'ES256');

  // kid: 公開鍵のSHA-256ハッシュの先頭16文字
  const jwk = await exportJWK(publicKey);
  const keyData = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyData));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const kid = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);

  const keys: JWTKeys = { privateKey, publicKey, kid };
  keyCache.set(cacheKey, keys);
  return keys;
}

export async function signAccessToken(
  payload: Omit<TokenPayload, 'exp' | 'iat' | 'jti' | 'kid'>,
  privateKeyPem: string,
  publicKeyPem: string
): Promise<string> {
  const { privateKey, kid } = await getJWTKeys(privateKeyPem, publicKeyPem);
  const jti = crypto.randomUUID();

  return new SignJWT({
    email: payload.email,
    role: payload.role,
  })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuer(payload.iss)
    .setSubject(payload.sub)
    .setAudience(payload.aud)
    .setIssuedAt()
    .setExpirationTime('15m')
    .setJti(jti)
    .sign(privateKey);
}

export async function verifyAccessToken(
  token: string,
  publicKeyPem: string,
  expectedAud: string,
  expectedIss: string
): Promise<TokenPayload> {
  const publicKey = await getCachedPublicKey(publicKeyPem);
  const { payload } = await jwtVerify(token, publicKey, {
    audience: expectedAud,
    issuer: expectedIss,
    algorithms: ['ES256'],
  });

  return payload as unknown as TokenPayload;
}

export async function getJWKS(publicKeyPem: string, kid: string): Promise<object> {
  const publicKey = await getCachedPublicKey(publicKeyPem);
  const jwk = await exportJWK(publicKey);
  return {
    keys: [
      {
        ...jwk,
        kid,
        use: 'sig',
        alg: 'ES256',
      },
    ],
  };
}
