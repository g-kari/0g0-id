import { describe, it, expect, expectTypeOf } from "vite-plus/test";
import type {
  AccessTokenInput,
  BffAccessTokenPayload,
  RelyingPartyAccessTokenPayload,
  TokenPayload,
} from "./types";
import type { verifyAccessToken } from "./lib/jwt";

const identity = {
  iss: "https://id.example.invalid",
  sub: "synthetic-internal-user-id",
  aud: "synthetic-client",
};
const metadata = { exp: 2, iat: 1, jti: "synthetic-jti" };

describe("access token type contracts", () => {
  it("new RP payloads omit profile while generic decode permits legacy fields", () => {
    const rp = {
      ...identity,
      ...metadata,
      cid: "synthetic-client",
    } satisfies RelyingPartyAccessTokenPayload;
    const legacy: TokenPayload = { ...rp, email: "synthetic@example.invalid", role: "user" };

    expectTypeOf<TokenPayload["email"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TokenPayload["role"]>().toEqualTypeOf<"user" | "admin" | undefined>();
    expectTypeOf<RelyingPartyAccessTokenPayload["email"]>().toEqualTypeOf<undefined>();
    expectTypeOf<RelyingPartyAccessTokenPayload["role"]>().toEqualTypeOf<undefined>();
    expectTypeOf<Awaited<ReturnType<typeof verifyAccessToken>>>().toEqualTypeOf<TokenPayload>();
    expect(rp).not.toHaveProperty("email");
    expect(rp).not.toHaveProperty("role");
    expect(legacy.email).toBe("synthetic@example.invalid");
  });

  it("BFF output retains required profile and RP signing needs no profile input", () => {
    const bff = {
      ...identity,
      ...metadata,
      email: "synthetic@example.invalid",
      role: "user",
    } satisfies BffAccessTokenPayload;
    const rpInput = { ...identity, cid: "synthetic-client" } satisfies AccessTokenInput;

    expectTypeOf<BffAccessTokenPayload["email"]>().toEqualTypeOf<string>();
    expectTypeOf<BffAccessTokenPayload["role"]>().toEqualTypeOf<"user" | "admin">();
    expectTypeOf<BffAccessTokenPayload["cid"]>().toEqualTypeOf<undefined>();
    expectTypeOf<typeof rpInput>().toMatchTypeOf<AccessTokenInput>();
    expectTypeOf<typeof identity>().not.toMatchTypeOf<AccessTokenInput>();
    expect(bff.email).toBe("synthetic@example.invalid");
    expect(rpInput).not.toHaveProperty("email");
    expect(rpInput).not.toHaveProperty("role");
  });
});
