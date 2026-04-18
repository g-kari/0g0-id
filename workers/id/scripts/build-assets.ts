/**
 * Workers Assets 用の静的ファイル生成スクリプト
 *
 * `dist/` に `.well-known/*` と `docs/*.json`、`_headers` を書き出す。
 * wrangler.toml の `[assets]` binding が `dist/` を配信するため、
 * これらのファイルは Cloudflare のエッジから直接返され Worker 起動を省ける。
 *
 * 公開鍵の取得順序:
 *   1. JWT_PUBLIC_KEY env var（ES256 公開鍵 PEM / SPKI 形式） — 鍵ローテーション時に使用
 *   2. リポジトリにコミットされた `public-key.jwk.json`（JWK 形式） — CI / 通常ビルド
 *
 * 公開鍵は `/.well-known/jwks.json` で誰でも取得できる公開情報のため、
 * JWK ファイルはリポジトリにコミットしてよい。
 *
 * その他の環境変数:
 *   IDP_ORIGIN — 任意。既定 "https://id.0g0.xyz"
 *
 * 実行: `npm run build:assets`（`tsx scripts/build-assets.ts`）
 * 通常は `npm run deploy` 内で `vp build` の後段に走る。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { exportJWK, importSPKI } from "jose";
import {
  buildBaseOidcMetadata,
  buildOpenIdConfiguration,
} from "../../../packages/shared/src/lib/oidc-metadata";
import { INTERNAL_OPENAPI } from "../src/routes/openapi/internal-spec";
import { EXTERNAL_OPENAPI } from "../src/routes/openapi/external-spec";

const DIST_URL = new URL("../dist/", import.meta.url);
const COMMITTED_JWK_URL = new URL("../public-key.jwk.json", import.meta.url);

const HEADERS_FILE = `/.well-known/jwks.json
  Cache-Control: public, max-age=3600

/.well-known/openid-configuration
  Content-Type: application/json
  Cache-Control: public, max-age=86400

/.well-known/oauth-authorization-server
  Content-Type: application/json
  Cache-Control: public, max-age=86400

/docs/openapi.json
  Cache-Control: public, max-age=3600

/docs/external/openapi.json
  Cache-Control: public, max-age=3600
`;

/** JWK の最小フォーマット（EC P-256 公開鍵） */
interface PublicJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
}

/** PEM か JWK のどちらか一方を受け取る */
type BuildOptions = {
  distDir: URL;
  idpOrigin: string;
} & ({ publicKeyPem: string; publicJwk?: never } | { publicJwk: PublicJwk; publicKeyPem?: never });

/** JWK に決定的 kid（SHA-256 先頭 16hex）と use/alg を付与して JWKS に整形する */
function jwkToJwks(jwk: PublicJwk): Promise<{ keys: object[] }> {
  const keyData = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyData)).then((hashBuffer) => {
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const kid = hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
    return { keys: [{ ...jwk, kid, use: "sig", alg: "ES256" }] };
  });
}

export async function buildJwks(publicKeyPem: string): Promise<{ keys: object[] }> {
  const publicKey = await importSPKI(publicKeyPem, "ES256");
  const jwk = (await exportJWK(publicKey)) as PublicJwk;
  return jwkToJwks(jwk);
}

export async function buildJwksFromJwk(jwk: PublicJwk): Promise<{ keys: object[] }> {
  return jwkToJwks(jwk);
}

export async function buildAssets(options: BuildOptions): Promise<void> {
  const { distDir, idpOrigin } = options;

  await mkdir(new URL(".well-known/", distDir), { recursive: true });
  await mkdir(new URL("docs/external/", distDir), { recursive: true });

  const jwks =
    "publicKeyPem" in options && options.publicKeyPem !== undefined
      ? await buildJwks(options.publicKeyPem)
      : await buildJwksFromJwk(options.publicJwk);
  await writeFile(new URL(".well-known/jwks.json", distDir), JSON.stringify(jwks));

  await writeFile(
    new URL(".well-known/openid-configuration", distDir),
    JSON.stringify(buildOpenIdConfiguration(idpOrigin)),
  );
  await writeFile(
    new URL(".well-known/oauth-authorization-server", distDir),
    JSON.stringify(buildBaseOidcMetadata(idpOrigin)),
  );

  await writeFile(new URL("docs/openapi.json", distDir), JSON.stringify(INTERNAL_OPENAPI));
  await writeFile(new URL("docs/external/openapi.json", distDir), JSON.stringify(EXTERNAL_OPENAPI));

  await writeFile(new URL("_headers", distDir), HEADERS_FILE);
}

/**
 * 公開鍵を以下の優先順で解決する:
 *   1. JWT_PUBLIC_KEY env var（PEM） — 鍵ローテーション時に使用
 *   2. リポジトリの `public-key.jwk.json`（JWK） — CI / 通常ビルド
 */
async function resolvePublicKey(): Promise<{ publicKeyPem: string } | { publicJwk: PublicJwk }> {
  const pem = process.env.JWT_PUBLIC_KEY;
  if (pem) return { publicKeyPem: pem };

  try {
    const jwkText = await readFile(COMMITTED_JWK_URL, "utf-8");
    const jwk = JSON.parse(jwkText) as PublicJwk;
    return { publicJwk: jwk };
  } catch (err) {
    throw new Error(
      `Failed to resolve public key: set JWT_PUBLIC_KEY env var, or commit public-key.jwk.json (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

async function main(): Promise<void> {
  const keySource = await resolvePublicKey();
  const idpOrigin = process.env.IDP_ORIGIN ?? "https://id.0g0.xyz";

  await buildAssets({ distDir: DIST_URL, idpOrigin, ...keySource });

  // eslint-disable-next-line no-console
  console.log(`[build-assets] wrote static files to ${fileURLToPath(DIST_URL)}`);
}

// このファイルが直接実行されたときのみ main() を呼ぶ（テストからの import 時は呼ばない）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
