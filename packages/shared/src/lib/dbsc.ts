/**
 * DBSC (Device Bound Session Credentials) ヘルパ
 *
 * Phase 1 では Chrome から送られる端末公開鍵 JWT (JWS over ES256) を検証し、
 * 公開 JWK を取り出して bff_sessions に保存するための最小限の処理を提供する。
 *
 * 仕様参考:
 *   https://w3c.github.io/webappsec-dbsc/
 *   https://developer.chrome.com/docs/web-platform/device-bound-session-credentials
 */

import { jwtVerify, importJWK, type JWK } from "jose";
import { decodeBase64Url } from "./base64url";

/** Chrome が送る登録 JWT のヘッダ部（jwk が必須）。 */
interface DbscRegistrationHeader {
  alg: string;
  typ?: string;
  jwk: JWK;
}

/** Phase 1 で受理する DBSC 登録 JWT のクレーム。仕様では aud / jti / iat / sub 程度が想定される。 */
export interface DbscRegistrationClaims {
  aud?: string;
  jti?: string;
  iat?: number;
  sub?: string;
}

export interface DbscVerificationResult {
  /** 検証済みの公開鍵 JWK（bff_sessions に保存する形式）。 */
  publicJwk: JWK;
  claims: DbscRegistrationClaims;
}

/** Phase 1 で受理するアルゴリズム（DBSC は ES256 を想定）。 */
const ALLOWED_ALG = "ES256";
/** 受理する key type / curve。 */
const ALLOWED_KTY = "EC";
const ALLOWED_CRV = "P-256";

/**
 * Chrome が送ってきた登録 JWT を検証する。
 *
 * - ヘッダの jwk フィールドから公開鍵を取り出し、その鍵で署名検証する（自署 = proof of possession）。
 * - alg / kty / crv が想定外であれば拒否する。
 * - 秘密鍵成分（d）が含まれる JWK は拒否する。
 * - audience は必須。リプレイされた他オリジン向け JWT を弾くために常に検証する。
 *
 * 検証失敗時は `Error` を投げる。呼び出し側は 400 系で応答すること。
 */
export async function verifyDbscRegistrationJwt(
  jwt: string,
  options: { audience: string },
): Promise<DbscVerificationResult> {
  const segments = jwt.split(".");
  if (segments.length !== 3) {
    throw new Error("DBSC JWT: malformed");
  }

  let header: DbscRegistrationHeader;
  try {
    header = JSON.parse(decodeBase64Url(segments[0])) as DbscRegistrationHeader;
  } catch {
    throw new Error("DBSC JWT: invalid header");
  }

  if (header.alg !== ALLOWED_ALG) {
    throw new Error(`DBSC JWT: unsupported alg ${header.alg}`);
  }
  if (!header.jwk || typeof header.jwk !== "object") {
    throw new Error("DBSC JWT: missing jwk in header");
  }
  const jwk = header.jwk;
  if (jwk.kty !== ALLOWED_KTY || jwk.crv !== ALLOWED_CRV) {
    throw new Error("DBSC JWT: unsupported key type");
  }
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("DBSC JWT: incomplete public key");
  }
  if ("d" in jwk && jwk.d !== undefined) {
    throw new Error("DBSC JWT: private key material not allowed");
  }

  const publicKey = await importJWK(jwk, ALLOWED_ALG);
  if (!(publicKey instanceof CryptoKey) || publicKey.type !== "public") {
    throw new Error("DBSC JWT: imported key is not a public key");
  }

  const { payload } = await jwtVerify(jwt, publicKey, {
    algorithms: [ALLOWED_ALG],
    audience: options.audience,
    requiredClaims: ["aud"],
  });

  return {
    publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    claims: payload as DbscRegistrationClaims,
  };
}

/**
 * Secure-Session-Registration ヘッダ値を組み立てる。
 * Chrome がログインレスポンスでこれを見つけると DBSC 登録フローを開始する。
 *
 * path は HTTP ヘッダにそのまま埋め込むため、CR/LF/" を含む値はインジェクション
 * リスクがあるので拒否する。algs も同様。
 */
export function buildSecureSessionRegistrationHeader(options: {
  /** 登録エンドポイントのパス（例: "/auth/dbsc/start"）。 */
  path: string;
  /** 受理する署名アルゴリズム。Phase 1 は ES256 のみ。 */
  algs?: string[];
}): string {
  const algs = options.algs ?? [ALLOWED_ALG];
  if (!/^\/[A-Za-z0-9/_\-.]*$/.test(options.path)) {
    throw new Error("DBSC: invalid registration path");
  }
  for (const alg of algs) {
    if (!/^[A-Za-z0-9]+$/.test(alg)) {
      throw new Error("DBSC: invalid alg name");
    }
  }
  return `(${algs.join(" ")});path="${options.path}"`;
}

/**
 * bff_sessions.device_public_key_jwk に保存された JSON 文字列を再検証つきで JWK に戻す。
 * 列の改ざん・破損があっても異常な公開鍵を import しないためのガード。
 */
export function parseStoredDbscPublicJwk(stored: string | null): JWK | null {
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const jwk = parsed as Record<string, unknown>;
  if (jwk.kty !== ALLOWED_KTY || jwk.crv !== ALLOWED_CRV) return null;
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") return null;
  if ("d" in jwk) return null;
  return { kty: ALLOWED_KTY, crv: ALLOWED_CRV, x: jwk.x, y: jwk.y };
}
