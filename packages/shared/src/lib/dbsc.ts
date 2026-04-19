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
 * `DBSC_ENFORCE_SENSITIVE` env var が「強制モード」扱いとみなされる文字列か判定する。
 *
 * secrets-store UI のコピペで trailing space や大文字が混入しても黙って
 * フェイルオープンにならないよう、`trim().toLowerCase() === "true"` で判定する。
 * `"1"` や `"yes"` は受理しない（明示的に `true` 相当の文字列のみ許容）。
 *
 * require-dbsc-bound ミドルウェアと、デプロイ preflight のガイド文言で挙動を
 * 一致させるための単一ソースとして export する（issue #155）。
 */
export function isDbscEnforceValue(raw: string | undefined | null): boolean {
  return (
    String(raw ?? "")
      .trim()
      .toLowerCase() === "true"
  );
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
 * DBSC リフレッシュ時の proof JWT（端末秘密鍵署名）に含めるクレーム。
 * 仕様に従い jti（= nonce）と aud（= BFF Origin）は必須。
 */
export interface DbscProofClaims {
  aud?: string;
  jti?: string;
  iat?: number;
  sub?: string;
}

/**
 * Chrome からリフレッシュ時に送られる proof JWT を既登録の公開鍵で検証する。
 *
 * - 登録 JWT と異なり、署名鍵は「登録時に保存した公開 JWK」。ヘッダ jwk は読まない
 *   （読むと攻撃者が別の公開鍵を詰められる）。
 * - alg / kty / crv を事前検証してから import することで、想定外鍵の読み込みを防ぐ。
 * - aud は必須。bff の SELF_ORIGIN と一致するかを呼び出し側で常に指定すること。
 * - nonce（jti）は呼び出し側で dbsc_challenges の consume と照合し、ワンタイム性を担保する。
 *
 * 失敗時は Error を投げる。呼び出し側は 400 系で応答すること。
 */
export async function verifyDbscProofJwt(
  jwt: string,
  options: { publicJwk: JWK; audience: string },
): Promise<{ claims: DbscProofClaims }> {
  const segments = jwt.split(".");
  if (segments.length !== 3) {
    throw new Error("DBSC proof: malformed");
  }

  let header: { alg?: unknown };
  try {
    header = JSON.parse(decodeBase64Url(segments[0])) as { alg?: unknown };
  } catch {
    throw new Error("DBSC proof: invalid header");
  }
  if (header.alg !== ALLOWED_ALG) {
    throw new Error(`DBSC proof: unsupported alg ${String(header.alg)}`);
  }

  const jwk = options.publicJwk;
  if (jwk.kty !== ALLOWED_KTY || jwk.crv !== ALLOWED_CRV) {
    throw new Error("DBSC proof: unsupported key type");
  }
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("DBSC proof: incomplete public key");
  }
  if ("d" in jwk && jwk.d !== undefined) {
    throw new Error("DBSC proof: private key material not allowed");
  }

  const publicKey = await importJWK(
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    ALLOWED_ALG,
  );
  if (!(publicKey instanceof CryptoKey) || publicKey.type !== "public") {
    throw new Error("DBSC proof: imported key is not a public key");
  }

  const { payload } = await jwtVerify(jwt, publicKey, {
    algorithms: [ALLOWED_ALG],
    audience: options.audience,
    requiredClaims: ["aud", "jti"],
  });

  return { claims: payload as DbscProofClaims };
}

/**
 * Secure-Session-Challenge ヘッダ値を組み立てる。
 *
 * Chrome は 403 応答のこのヘッダから nonce を取り出し、秘密鍵で署名した proof JWT を再送する。
 * 仕様形式は RFC 8941 Structured Field (String) 相当の `"<nonce>"`。
 * nonce は base64url 等の安全な文字のみを想定し、CR/LF/" を含む値は拒否する。
 */
export function buildSecureSessionChallengeHeader(nonce: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) {
    throw new Error("DBSC: invalid challenge nonce");
  }
  return `"${nonce}"`;
}

/**
 * Secure-Session-Challenge ヘッダ／リクエストヘッダから nonce を取り出す。
 * 不正形式は null を返す。
 */
export function parseSecureSessionChallengeHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = /^"([A-Za-z0-9_-]+)"$/.exec(trimmed);
  return match ? match[1] : null;
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
