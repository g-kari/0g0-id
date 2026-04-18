import { describe, it, expect } from "vite-plus/test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  verifyDbscRegistrationJwt,
  verifyDbscProofJwt,
  buildSecureSessionRegistrationHeader,
  buildSecureSessionChallengeHeader,
  parseSecureSessionChallengeHeader,
  parseStoredDbscPublicJwk,
} from "./dbsc";

async function buildRegistrationJwt(options: { audience?: string } = {}): Promise<{
  jwt: string;
  publicJwk: Awaited<ReturnType<typeof exportJWK>>;
}> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const jwt = await new SignJWT(options.audience ? { aud: options.audience } : {})
    .setProtectedHeader({ alg: "ES256", typ: "jwt", jwk: publicJwk })
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .sign(privateKey);
  void publicKey;
  return { jwt, publicJwk };
}

describe("verifyDbscRegistrationJwt", () => {
  it("自署 JWT を検証して公開 JWK を返す", async () => {
    const { jwt, publicJwk } = await buildRegistrationJwt({ audience: "https://admin.0g0.xyz" });
    const { publicJwk: extracted, claims } = await verifyDbscRegistrationJwt(jwt, {
      audience: "https://admin.0g0.xyz",
    });
    expect(extracted.kty).toBe("EC");
    expect(extracted.crv).toBe("P-256");
    expect(extracted.x).toBe(publicJwk.x);
    expect(extracted.y).toBe(publicJwk.y);
    expect(claims.jti).toBeTypeOf("string");
  });

  it("aud クレームが無い JWT を拒否する", async () => {
    const { jwt } = await buildRegistrationJwt(); // aud 無し
    await expect(
      verifyDbscRegistrationJwt(jwt, { audience: "https://admin.0g0.xyz" }),
    ).rejects.toThrow();
  });

  it("audience が一致しない JWT を拒否する", async () => {
    const { jwt } = await buildRegistrationJwt({ audience: "https://other.example" });
    await expect(
      verifyDbscRegistrationJwt(jwt, { audience: "https://admin.0g0.xyz" }),
    ).rejects.toThrow();
  });

  it("alg が ES256 でない JWT を拒否する", async () => {
    const fakeHeader = {
      alg: "HS256",
      typ: "jwt",
      jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    };
    const enc = (s: string) => btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const jwt = `${enc(JSON.stringify(fakeHeader))}.${enc("{}")}.${enc("sig")}`;
    await expect(verifyDbscRegistrationJwt(jwt, { audience: "x" })).rejects.toThrow(
      /unsupported alg/,
    );
  });

  it("ヘッダに jwk が無い JWT を拒否する", async () => {
    const enc = (s: string) => btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const jwt = `${enc(JSON.stringify({ alg: "ES256" }))}.${enc("{}")}.${enc("sig")}`;
    await expect(verifyDbscRegistrationJwt(jwt, { audience: "x" })).rejects.toThrow(/missing jwk/);
  });

  it("秘密鍵を含む JWK を拒否する", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const jwt = await new SignJWT({ aud: "x" })
      .setProtectedHeader({ alg: "ES256", typ: "jwt", jwk: privateJwk })
      .sign(privateKey);
    await expect(verifyDbscRegistrationJwt(jwt, { audience: "x" })).rejects.toThrow(
      /private key material/,
    );
  });

  it("kty が EC でない JWK を拒否する", async () => {
    const enc = (s: string) => btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const header = { alg: "ES256", typ: "jwt", jwk: { kty: "RSA", n: "x", e: "AQAB" } };
    const jwt = `${enc(JSON.stringify(header))}.${enc("{}")}.${enc("sig")}`;
    await expect(verifyDbscRegistrationJwt(jwt, { audience: "x" })).rejects.toThrow(
      /unsupported key type/,
    );
  });

  it("形式が壊れた JWT を拒否する", async () => {
    await expect(verifyDbscRegistrationJwt("not.a.jwt.really", { audience: "x" })).rejects.toThrow(
      /malformed/,
    );
  });
});

describe("buildSecureSessionRegistrationHeader", () => {
  it("デフォルトで ES256 のみを宣言する", () => {
    const v = buildSecureSessionRegistrationHeader({ path: "/auth/dbsc/start" });
    expect(v).toBe('(ES256);path="/auth/dbsc/start"');
  });

  it("複数アルゴリズムをスペース区切りで列挙する", () => {
    const v = buildSecureSessionRegistrationHeader({ path: "/x", algs: ["ES256", "ES384"] });
    expect(v).toBe('(ES256 ES384);path="/x"');
  });

  it("CR/LF を含むパスを拒否する（ヘッダインジェクション対策）", () => {
    expect(() =>
      buildSecureSessionRegistrationHeader({ path: "/auth/dbsc/start\r\nX-Inj: yes" }),
    ).toThrow();
  });

  it("引用符を含むパスを拒否する", () => {
    expect(() => buildSecureSessionRegistrationHeader({ path: '/x";evil' })).toThrow();
  });

  it("不正な alg 名を拒否する", () => {
    expect(() =>
      buildSecureSessionRegistrationHeader({ path: "/x", algs: ["ES256;evil"] }),
    ).toThrow();
  });
});

describe("buildSecureSessionChallengeHeader / parseSecureSessionChallengeHeader", () => {
  it("nonce を引用符で括った Structured Field を返す", () => {
    expect(buildSecureSessionChallengeHeader("abc_123-xyz")).toBe('"abc_123-xyz"');
  });
  it("CR/LF / 引用符を含む nonce を拒否する", () => {
    expect(() => buildSecureSessionChallengeHeader('evil"')).toThrow();
    expect(() => buildSecureSessionChallengeHeader("a\r\nb")).toThrow();
  });
  it("空文字の nonce を拒否する", () => {
    expect(() => buildSecureSessionChallengeHeader("")).toThrow();
  });
  it("ヘッダ値をパースして nonce を取り出す", () => {
    expect(parseSecureSessionChallengeHeader('"abc_123"')).toBe("abc_123");
  });
  it("不正形式は null", () => {
    expect(parseSecureSessionChallengeHeader(null)).toBeNull();
    expect(parseSecureSessionChallengeHeader(undefined)).toBeNull();
    expect(parseSecureSessionChallengeHeader("no-quotes")).toBeNull();
    expect(parseSecureSessionChallengeHeader('"bad chars!"')).toBeNull();
  });
});

describe("verifyDbscProofJwt", () => {
  async function makeProofJwt(options: {
    aud?: string;
    jti?: string;
    signer?: "same" | "other";
  }): Promise<{ jwt: string; publicJwk: Awaited<ReturnType<typeof exportJWK>> }> {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const signingKey =
      options.signer === "other"
        ? (await generateKeyPair("ES256", { extractable: true })).privateKey
        : privateKey;
    const signer = new SignJWT(options.aud ? { aud: options.aud } : {})
      .setProtectedHeader({ alg: "ES256", typ: "jwt" })
      .setIssuedAt();
    if (options.jti) signer.setJti(options.jti);
    const jwt = await signer.sign(signingKey);
    return { jwt, publicJwk };
  }

  it("端末公開鍵で署名された proof JWT を検証して jti を返す", async () => {
    const { jwt, publicJwk } = await makeProofJwt({
      aud: "https://admin.0g0.xyz",
      jti: "nonce-abc",
    });
    const { claims } = await verifyDbscProofJwt(jwt, {
      publicJwk,
      audience: "https://admin.0g0.xyz",
    });
    expect(claims.jti).toBe("nonce-abc");
    expect(claims.aud).toBe("https://admin.0g0.xyz");
  });

  it("aud 不一致を拒否する", async () => {
    const { jwt, publicJwk } = await makeProofJwt({
      aud: "https://other.example",
      jti: "n1",
    });
    await expect(
      verifyDbscProofJwt(jwt, { publicJwk, audience: "https://admin.0g0.xyz" }),
    ).rejects.toThrow();
  });

  it("aud / jti が無い proof を拒否する", async () => {
    const { jwt, publicJwk } = await makeProofJwt({ jti: "n1" }); // aud なし
    await expect(
      verifyDbscProofJwt(jwt, { publicJwk, audience: "https://admin.0g0.xyz" }),
    ).rejects.toThrow();
  });

  it("別の鍵で署名された proof は署名検証で拒否される", async () => {
    const { jwt, publicJwk } = await makeProofJwt({
      aud: "https://admin.0g0.xyz",
      jti: "n1",
      signer: "other",
    });
    await expect(
      verifyDbscProofJwt(jwt, { publicJwk, audience: "https://admin.0g0.xyz" }),
    ).rejects.toThrow();
  });

  it("alg が ES256 でない header を拒否する", async () => {
    const { publicJwk } = await makeProofJwt({ aud: "x", jti: "n1" });
    const enc = (s: string) => btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const jwt = `${enc(JSON.stringify({ alg: "HS256", typ: "jwt" }))}.${enc("{}")}.${enc("sig")}`;
    await expect(verifyDbscProofJwt(jwt, { publicJwk, audience: "x" })).rejects.toThrow(
      /unsupported alg/,
    );
  });

  it("形式が壊れた JWT を拒否する", async () => {
    const { publicJwk } = await makeProofJwt({ aud: "x", jti: "n1" });
    await expect(
      verifyDbscProofJwt("not.a.jwt.really", { publicJwk, audience: "x" }),
    ).rejects.toThrow(/malformed/);
  });
});

describe("parseStoredDbscPublicJwk", () => {
  it("正規の保存値をパースする", async () => {
    const { publicJwk } = await buildRegistrationJwt({ audience: "x" });
    const parsed = parseStoredDbscPublicJwk(JSON.stringify(publicJwk));
    expect(parsed?.kty).toBe("EC");
    expect(parsed?.crv).toBe("P-256");
  });
  it("null は null を返す", () => {
    expect(parseStoredDbscPublicJwk(null)).toBeNull();
  });
  it("kty / crv が不正なら null", () => {
    expect(parseStoredDbscPublicJwk('{"kty":"RSA","n":"x","e":"AQAB"}')).toBeNull();
  });
  it("秘密鍵成分 d を含む JWK は null", () => {
    expect(
      parseStoredDbscPublicJwk('{"kty":"EC","crv":"P-256","x":"a","y":"b","d":"c"}'),
    ).toBeNull();
  });
  it("壊れた JSON は null", () => {
    expect(parseStoredDbscPublicJwk("not-json")).toBeNull();
  });
});
