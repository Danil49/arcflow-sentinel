import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { canonicalize } from "./canonical.js";
import { keyIdOf, publicKeyFromHex, type EvidenceSigner } from "./keys.js";

export const EVIDENCE_SCHEMA = "arcflow-sentinel/evidence/v1";

/**
 * What a bundle attests to. Every field is plain JSON (amounts and block numbers as decimal
 * strings). It deliberately has no "generated at" time: the same evidence and verdict always
 * produce the same bytes, hence the same hash, so a hash anchored on chain stays meaningful.
 */
export interface EvidencePayload {
  schema: typeof EVIDENCE_SCHEMA;
  network: "mainnet" | "testnet";
  trace: {
    id: string;
    sourceDomain: number;
    destinationDomain: number;
    sourceChainId: number;
    sourceTxHash: string;
    sourceLogIndex: number;
    sourceBlockNumber: string;
    sourceBlockTime: string | null;
    nonce: string | null;
    sender: string;
    recipient: string;
    amountAtomic: string;
    destinationTxHash: string | null;
    requireAppConfirmation: boolean;
    applicationConfirmedAt: string | null;
    applicationReference: string | null;
  };
  verdict: {
    status: string;
    progress: string;
    reason: string | null;
    statusReason: string | null;
    stageDeadlineAt: string | null;
  };
  invariants: Array<{
    ruleId: string;
    result: string;
    explanation: string;
    evidenceRefs: string[];
  }>;
  observations: {
    chainEvents: Array<{
      chainId: number;
      domain: number;
      blockNumber: string;
      blockHash: string;
      txHash: string;
      logIndex: number;
      eventType: string;
      removed: boolean;
      observedAt: string;
      decoded: unknown;
    }>;
    attestations: Array<{
      status: string;
      nonce: string | null;
      delayReason: string | null;
      responseHash: string;
      observedAt: string;
    }>;
  };
}

export interface EvidenceBundle {
  payload: EvidencePayload;
  /** Both over the canonical (RFC 8785) payload bytes. keccak256 is what gets anchored on Arc. */
  hashes: { sha256: string; keccak256: `0x${string}` };
  signature: {
    alg: "Ed25519";
    keyId: string;
    /** Informational. Verify against the operator's published key, not this field. */
    publicKey: string;
    /** base64 Ed25519 signature over the canonical payload bytes. */
    value: string;
  };
}

/** Sorts collections so equal evidence always serializes identically, whatever the DB order. */
function normalizePayload(p: EvidencePayload): EvidencePayload {
  const byKey =
    <T>(key: (x: T) => string) =>
    (a: T, b: T) =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  return {
    ...p,
    invariants: [...p.invariants].sort(byKey((i) => i.ruleId)),
    observations: {
      chainEvents: [...p.observations.chainEvents].sort(
        byKey(
          (e) =>
            `${String(e.chainId).padStart(10, "0")}:${e.blockNumber.padStart(20, "0")}:${String(e.logIndex).padStart(6, "0")}:${e.txHash}`,
        ),
      ),
      attestations: [...p.observations.attestations].sort(
        byKey((a) => `${a.observedAt}:${a.responseHash}`),
      ),
    },
  };
}

export function canonicalPayloadBytes(payload: EvidencePayload): Buffer {
  return Buffer.from(canonicalize(payload), "utf8");
}

export function hashPayload(bytes: Uint8Array): EvidenceBundle["hashes"] {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    keccak256: keccak256(bytes),
  };
}

export function sealEvidence(payload: EvidencePayload, signer: EvidenceSigner): EvidenceBundle {
  const normalized = normalizePayload(payload);
  const bytes = canonicalPayloadBytes(normalized);
  return {
    payload: normalized,
    hashes: hashPayload(bytes),
    signature: {
      alg: "Ed25519",
      keyId: signer.keyId,
      publicKey: signer.publicKeyHex,
      value: sign(null, bytes, signer.privateKey).toString("base64"),
    },
  };
}

export interface VerificationResult {
  ok: boolean;
  checks: {
    schema: boolean;
    sha256: boolean;
    keccak256: boolean;
    keyId: boolean;
    signature: boolean;
  };
  /** The recomputed keccak256, to compare with an on-chain anchor. */
  keccak256: `0x${string}`;
  errors: string[];
}

/**
 * Recomputes the canonical bytes and hashes and checks the signature against `trustedPublicKey`
 * (hex). Pass the operator's published key: the key embedded in the bundle proves nothing alone.
 */
export function verifyEvidence(
  bundle: EvidenceBundle,
  trustedPublicKey: string,
): VerificationResult {
  const errors: string[] = [];
  const bytes = canonicalPayloadBytes(bundle.payload);
  const hashes = hashPayload(bytes);
  let key: KeyObject | null = null;
  try {
    key = publicKeyFromHex(trustedPublicKey);
  } catch (e) {
    errors.push((e as Error).message);
  }
  let signatureOk = false;
  if (key) {
    try {
      signatureOk = verify(null, bytes, key, Buffer.from(bundle.signature?.value ?? "", "base64"));
    } catch {
      signatureOk = false;
    }
  }
  const checks = {
    schema: bundle.payload?.schema === EVIDENCE_SCHEMA,
    sha256: bundle.hashes?.sha256 === hashes.sha256,
    keccak256: bundle.hashes?.keccak256?.toLowerCase() === hashes.keccak256,
    keyId: bundle.signature?.keyId === (key ? keyIdOf(trustedPublicKey) : undefined),
    signature: signatureOk,
  };
  if (!checks.schema) errors.push(`unknown schema ${String(bundle.payload?.schema)}`);
  if (!checks.sha256) errors.push("sha256 does not match the payload");
  if (!checks.keccak256) errors.push("keccak256 does not match the payload");
  if (!checks.keyId) errors.push("bundle was signed with a different key id");
  if (!checks.signature) errors.push("signature is not valid for this payload and key");
  return { ok: Object.values(checks).every(Boolean), checks, keccak256: hashes.keccak256, errors };
}

/** Bytes32 helper for anchoring (the contract takes the keccak256 as bytes32). */
export const evidenceHashBytes = (bundle: EvidenceBundle) => toBytes(bundle.hashes.keccak256);
