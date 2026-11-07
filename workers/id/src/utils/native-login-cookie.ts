/** Small, short-lived encrypted envelopes; never reuse an OAuth/BFF cookie. */
import { isoBase64URL } from "@simplewebauthn/server/helpers";

const encoder = new TextEncoder();
const MAX_PLAINTEXT_BYTES = 2600;
const CONTEXT = "0g0-id-native-passkey-login-v1";
export type NativeCookiePurpose = "browser" | "continuation";

async function key(secret: string, purpose: NativeCookiePurpose) {
  if (secret.length < 32) throw new Error("Native login configuration unavailable");
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(CONTEXT),
      info: encoder.encode(purpose),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealNativeCookie(
  data: Record<string, unknown>,
  secret: string,
  purpose: NativeCookiePurpose,
  origin: string,
  expiresAt: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(expiresAt) || expiresAt <= now || expiresAt > now + 600)
    throw new Error("Invalid native cookie expiry");
  const plaintext = encoder.encode(JSON.stringify({ ...data, purpose, exp: expiresAt }));
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error("Native login state too large");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(`${CONTEXT}:${purpose}:${origin}`) },
    await key(secret, purpose),
    plaintext,
  );
  const bytes = new Uint8Array(iv.length + ciphertext.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(ciphertext), iv.length);
  return isoBase64URL.fromBuffer(bytes);
}

export async function openNativeCookie(
  encoded: string | undefined,
  secret: string,
  purpose: NativeCookiePurpose,
  origin: string,
): Promise<Record<string, unknown> | null> {
  try {
    if (!encoded || encoded.length > 3600 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const bytes = isoBase64URL.toBuffer(encoded);
    if (bytes.length < 29 || isoBase64URL.fromBuffer(bytes) !== encoded) return null;
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.slice(0, 12),
        additionalData: encoder.encode(`${CONTEXT}:${purpose}:${origin}`),
      },
      await key(secret, purpose),
      bytes.slice(12),
    );
    if (plain.byteLength > MAX_PLAINTEXT_BYTES) return null;
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    return obj.purpose === purpose &&
      typeof obj.exp === "number" &&
      Number.isInteger(obj.exp) &&
      obj.exp > now &&
      obj.exp <= now + 600
      ? obj
      : null;
  } catch {
    return null;
  }
}
