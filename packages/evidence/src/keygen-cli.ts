/** Generates an Ed25519 evidence signing key. Store the seed as EVIDENCE_SIGNING_KEY (secret). */
import { randomBytes } from "node:crypto";
import { signerFromSeed } from "./keys.js";

const seed = randomBytes(32).toString("hex");
const signer = signerFromSeed(seed);
console.log(`EVIDENCE_SIGNING_KEY=${seed}`);
console.log(`# public key (publish this): ${signer.publicKeyHex}`);
console.log(`# key id: ${signer.keyId}`);
