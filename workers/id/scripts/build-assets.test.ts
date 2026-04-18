import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPair, exportSPKI } from "jose";

import { buildAssets, buildJwks } from "./build-assets";

describe("build-assets", () => {
  let tmpDir: string;
  let publicKeyPem: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "id-assets-test-"));
    const { publicKey } = await generateKeyPair("ES256", { extractable: true });
    publicKeyPem = await exportSPKI(publicKey);
    const distUrl = new URL(`${pathToFileURL(tmpDir).href}/`);
    await buildAssets({
      distDir: distUrl,
      publicKeyPem,
      idpOrigin: "https://id.test.example",
    });
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("jwks.json に ES256 鍵 1本が含まれ kid がセットされる", async () => {
    const jwks = JSON.parse(await readFile(join(tmpDir, ".well-known/jwks.json"), "utf-8")) as {
      keys: Array<{ kid: string; use: string; alg: string; kty: string }>;
    };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.alg).toBe("ES256");
    expect(jwks.keys[0]?.use).toBe("sig");
    expect(jwks.keys[0]?.kty).toBe("EC");
    expect(jwks.keys[0]?.kid).toMatch(/^[0-9a-f]{16}$/);
  });

  it("openid-configuration に issuer / jwks_uri が反映される", async () => {
    const oidc = JSON.parse(
      await readFile(join(tmpDir, ".well-known/openid-configuration"), "utf-8"),
    ) as { issuer: string; jwks_uri: string; id_token_signing_alg_values_supported: string[] };
    expect(oidc.issuer).toBe("https://id.test.example");
    expect(oidc.jwks_uri).toBe("https://id.test.example/.well-known/jwks.json");
    expect(oidc.id_token_signing_alg_values_supported).toContain("ES256");
  });

  it("oauth-authorization-server が base メタデータを返す", async () => {
    const meta = JSON.parse(
      await readFile(join(tmpDir, ".well-known/oauth-authorization-server"), "utf-8"),
    ) as { issuer: string; code_challenge_methods_supported: string[] };
    expect(meta.issuer).toBe("https://id.test.example");
    expect(meta.code_challenge_methods_supported).toContain("S256");
  });

  it("内部/外部 OpenAPI JSON が出力される", async () => {
    const internal = JSON.parse(await readFile(join(tmpDir, "docs/openapi.json"), "utf-8")) as {
      openapi: string;
      info: { title: string };
    };
    const external = JSON.parse(
      await readFile(join(tmpDir, "docs/external/openapi.json"), "utf-8"),
    ) as { openapi: string; info: { title: string } };
    expect(internal.openapi).toMatch(/^3\./);
    expect(external.openapi).toMatch(/^3\./);
    expect(typeof internal.info.title).toBe("string");
    expect(typeof external.info.title).toBe("string");
  });

  it("_headers に Content-Type と Cache-Control が記載される", async () => {
    const headers = await readFile(join(tmpDir, "_headers"), "utf-8");
    expect(headers).toContain("/.well-known/openid-configuration");
    expect(headers).toContain("Content-Type: application/json");
    expect(headers).toContain("Cache-Control: public, max-age=86400");
  });

  it("buildJwks は同じ公開鍵から決定的な kid を返す", async () => {
    const jwks1 = await buildJwks(publicKeyPem);
    const jwks2 = await buildJwks(publicKeyPem);
    const kid1 = (jwks1.keys[0] as { kid: string }).kid;
    const kid2 = (jwks2.keys[0] as { kid: string }).kid;
    expect(kid1).toBe(kid2);
  });
});
