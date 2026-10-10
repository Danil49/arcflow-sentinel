import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

// DER prefixes for raw Ed25519 keys (RFC 8410): PKCS#8 private, SPKI public.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class KeyError extends Error {
  override name = "KeyError";
}

const hex32 = (value: string, what: string) => {
  const clean = value.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new KeyError(`${what} must be 32 bytes of hex`);
  return Buffer.from(clean, "hex");
};

export interface EvidenceSigner {
  keyId: string;
  publicKeyHex: string;
  privateKey: KeyObject;
}

/** keyId = first 16 hex chars of SHA-256(raw public key): short, stable, collision-safe enough to pick a key. */
export const keyIdOf = (publicKeyHex: string) =>
  createHash("sha256").update(hex32(publicKeyHex, "public key")).digest("hex").slice(0, 16);

/** Signer from a 32-byte Ed25519 seed (hex), e.g. EVIDENCE_SIGNING_KEY. */
export function signerFromSeed(seedHex: string): EvidenceSigner {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, hex32(seedHex, "EVIDENCE_SIGNING_KEY")]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKeyHex = spki.subarray(SPKI_PREFIX.length).toString("hex");
  return { keyId: keyIdOf(publicKeyHex), publicKeyHex, privateKey };
}

export function publicKeyFromHex(publicKeyHex: string): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, hex32(publicKeyHex, "public key")]),
    format: "der",
    type: "spki",
  });
}
