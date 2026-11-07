// Public test vectors from SimpleWebAuthn v14.0.3 (MIT). See LICENSE.simplewebauthn.md.
// https://github.com/MasterKale/SimpleWebAuthn/blob/v14.0.3/packages/server/src/registration/verifyRegistrationResponse.test.ts
// https://github.com/MasterKale/SimpleWebAuthn/blob/v14.0.3/packages/server/src/authentication/verifyAuthenticationResponse.test.ts
// Upstream assertions have UP but NOT UV: use them to test strict rejection, not successful login.
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
export const attestationNone: RegistrationResponseJSON = {
  id: "AdKXJEch1aV5Wo7bj7qLHskVY4OoNaj9qu8TPdJ7kSAgUeRxWNngXlcNIGt4gexZGKVGcqZpqqWordXb_he1izY",
  rawId: "AdKXJEch1aV5Wo7bj7qLHskVY4OoNaj9qu8TPdJ7kSAgUeRxWNngXlcNIGt4gexZGKVGcqZpqqWordXb_he1izY",
  response: {
    attestationObject:
      "o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVjFPdxHEOnAiLIp26idVjIguzn3I" +
      "pr_RlsKZWsa-5qK-KBFAAAAAAAAAAAAAAAAAAAAAAAAAAAAQQHSlyRHIdWleVqO24-6ix7JFWODqDWo_arvEz3Se" +
      "5EgIFHkcVjZ4F5XDSBreIHsWRilRnKmaaqlqK3V2_4XtYs2pQECAyYgASFYID5PQTZQQg6haZFQWFzqfAOyQ_ENs" +
      "MH8xxQ4GRiNPsqrIlggU8IVUOV8qpgk_Jh-OTaLuZL52KdX1fTht07X4DiQPow",
    clientDataJSON:
      "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiYUVWalkxQlhkWHBw" +
      "VURBd1NEQndOV2Q0YURKZmRUVmZVRU0wVG1WWloyUSIsIm9yaWdpbiI6Imh0dHBzOlwvXC9kZXYuZG9udG5lZWRh" +
      "LnB3IiwiYW5kcm9pZFBhY2thZ2VOYW1lIjoib3JnLm1vemlsbGEuZmlyZWZveCJ9",
    transports: [],
  },
  type: "public-key",
  clientExtensionResults: {},
};
export const attestationNoneChallenge = isoBase64URL.fromUTF8String(
  "hEccPWuziP00H0p5gxh2_u5_PC4NeYgd",
);
export const assertionResponse: AuthenticationResponseJSON = {
  id: "KEbWNCc7NgaYnUyrNeFGX9_3Y-8oJ3KwzjnaiD1d1LVTxR7v3CaKfCz2Vy_g_MHSh7yJ8yL0Pxg6jo_o0hYiew",
  rawId: "KEbWNCc7NgaYnUyrNeFGX9_3Y-8oJ3KwzjnaiD1d1LVTxR7v3CaKfCz2Vy_g_MHSh7yJ8yL0Pxg6jo_o0hYiew",
  response: {
    authenticatorData: "PdxHEOnAiLIp26idVjIguzn3Ipr_RlsKZWsa-5qK-KABAAAAkA==",
    clientDataJSON:
      "eyJjaGFsbGVuZ2UiOiJkRzkwWVd4c2VWVnVhWEYxWlZaaGJIVmxSWFpsY25sVWFXMWwiLCJj" +
      "bGllbnRFeHRlbnNpb25zIjp7fSwiaGFzaEFsZ29yaXRobSI6IlNIQS0yNTYiLCJvcmlnaW4iOiJodHRwczovL2Rldi5k" +
      "b250bmVlZGEucHciLCJ0eXBlIjoid2ViYXV0aG4uZ2V0In0=",
    signature:
      "MEUCIQDYXBOpCWSWq2Ll4558GJKD2RoWg958lvJSB_GdeokxogIgWuEVQ7ee6AswQY0OsuQ6y8Ks6" +
      "jhd45bDx92wjXKs900=",
  },
  clientExtensionResults: {},
  type: "public-key",
};
export const assertionChallenge = isoBase64URL.fromUTF8String("totallyUniqueValueEveryTime");
export const assertionOrigin = "https://dev.dontneeda.pw";
export const credential: WebAuthnCredential = {
  publicKey: isoBase64URL.toBuffer(
    "pQECAyYgASFYIIheFp-u6GvFT2LNGovf3ZrT0iFVBsA_76rRysxRG9A1Ilgg8WGeA6hPmnab0HAViUYVRkwTNcN77QBf_RR0dv3lIvQ",
  ),
  id: "KEbWNCc7NgaYnUyrNeFGX9_3Y-8oJ3KwzjnaiD1d1LVTxR7v3CaKfCz2Vy_g_MHSh7yJ8yL0Pxg6jo_o0hYiew",
  counter: 143,
};
