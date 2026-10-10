import { describe, expect, it } from "vitest";
import {
  canonicalize,
  CanonicalizationError,
  EVIDENCE_SCHEMA,
  sealEvidence,
  signerFromSeed,
  verifyEvidence,
  type EvidencePayload,
} from "../src/index.js";

// RFC 8032 test vector 1 seed: deterministic keys for tests.
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC8032_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const signer = signerFromSeed(SEED);
const other = signerFromSeed("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");

const payload = (): EvidencePayload => ({
  schema: EVIDENCE_SCHEMA,
  network: "mainnet",
  trace: {
    id: "1496fa54-48fd-48dd-93ce-ec6430527943",
    sourceDomain: 6,
    destinationDomain: 26,
    sourceChainId: 8453,
    sourceTxHash: "0x219163cb00c8535d2b3181d4ec4df21ebad0c88e1f6de4708722b735e132e41e",
    sourceLogIndex: 8,
    sourceBlockNumber: "52308155",
    sourceBlockTime: "2026-10-07T20:00:00.000Z",
    nonce: "0x1f73af1b2ee099c698d297119d9f995d70d1682f9247bc5bbb516f8114fe68b5",
    sender: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
    recipient: "0x299229222148e00Cee5676446eEd9baB5231D062",
    amountAtomic: "5869596",
    destinationTxHash: "0x5281793bd4fff55ae84529b2e726a05034f45d5bed84454c75b7344135ceec39",
    requireAppConfirmation: false,
    applicationConfirmedAt: null,
    applicationReference: null,
  },
  verdict: {
    status: "MINT_CONFIRMED",
    progress: "MINT_CONFIRMED",
    reason: null,
    statusReason: null,
    stageDeadlineAt: null,
  },
  invariants: [
    {
      ruleId: "value-conservation",
      result: "PASS",
      explanation: "burned 5869596 = minted 5869596 + fee 0",
      evidenceRefs: [],
    },
    {
      ruleId: "domain-integrity",
      result: "PASS",
      explanation: "all observations on route 6->26",
      evidenceRefs: [],
    },
  ],
  observations: {
    chainEvents: [
      {
        chainId: 5042,
        domain: 26,
        blockNumber: "24791398",
        blockHash: "0xaa",
        txHash: "0x52",
        logIndex: 3,
        eventType: "mint",
        removed: false,
        observedAt: "2026-10-07T20:20:00.000Z",
        decoded: { amount: "5869596" },
      },
      {
        chainId: 8453,
        domain: 6,
        blockNumber: "52308155",
        blockHash: "0xbb",
        txHash: "0x21",
        logIndex: 8,
        eventType: "burn",
        removed: false,
        observedAt: "2026-10-07T20:01:00.000Z",
        decoded: { amount: "5869596" },
      },
    ],
    attestations: [
      {
        status: "complete",
        nonce: "0x1f73",
        delayReason: null,
        responseHash: "ab12",
        observedAt: "2026-10-07T20:19:00.000Z",
      },
    ],
  },
});

describe("canonicalize (RFC 8785)", () => {
  it("sorts keys by UTF-16 code units and drops whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], "€": 0, "\r": 1, "1": 2 })).toBe(
      '{"\\r":1,"1":2,"a":[true,null,"x"],"b":1,"€":0}',
    );
  });

  it("uses ECMAScript number serialization", () => {
    expect(canonicalize([1e30, 4.5, 0.002, 1e-7, -0, 333333333.3333333])).toBe(
      "[1e+30,4.5,0.002,1e-7,0,333333333.3333333]",
    );
  });

  it("escapes strings like JSON.stringify", () => {
    expect(canonicalize('€$\u000f\nA\'B"\\\\"/')).toBe('"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"');
  });

  it("rejects values JSON cannot represent exactly", () => {
    expect(() => canonicalize(1n)).toThrow(CanonicalizationError);
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalize(new Date())).toThrow(CanonicalizationError);
  });
});

describe("signing keys", () => {
  it("derives the RFC 8032 public key from the seed", () => {
    expect(signer.publicKeyHex).toBe(RFC8032_PUBLIC);
    expect(signer.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(() => signerFromSeed("abc")).toThrow(/32 bytes/);
  });
});

describe("sealEvidence / verifyEvidence", () => {
  it("round-trips and exposes the keccak256 to anchor", () => {
    const bundle = sealEvidence(payload(), signer);
    const r = verifyEvidence(bundle, signer.publicKeyHex);
    expect(r).toMatchObject({ ok: true, errors: [] });
    expect(r.keccak256).toBe(bundle.hashes.keccak256);
    expect(bundle.hashes.keccak256).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic: same evidence in any order gives the same hashes and signature", () => {
    const a = sealEvidence(payload(), signer);
    const p = payload();
    p.invariants.reverse();
    p.observations.chainEvents.reverse();
    const b = sealEvidence(JSON.parse(JSON.stringify(p)), signer);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.signature.value).toBe(a.signature.value); // Ed25519 is deterministic
  });

  it("survives a JSON round trip (download, re-upload)", () => {
    const bundle = JSON.parse(JSON.stringify(sealEvidence(payload(), signer)));
    expect(verifyEvidence(bundle, signer.publicKeyHex).ok).toBe(true);
  });

  it("detects a tampered payload", () => {
    const bundle = sealEvidence(payload(), signer);
    bundle.payload.trace.amountAtomic = "5869597";
    const r = verifyEvidence(bundle, signer.publicKeyHex);
    expect(r.ok).toBe(false);
    expect(r.checks).toMatchObject({ sha256: false, keccak256: false, signature: false });
  });

  it("detects re-hashing without the key (hashes updated, signature stale)", () => {
    const tampered = payload();
    tampered.verdict.status = "FAILED_OR_STUCK";
    const resealed = sealEvidence(tampered, other); // attacker can hash, but not sign as `signer`
    const forged = {
      ...sealEvidence(payload(), signer),
      payload: resealed.payload,
      hashes: resealed.hashes,
    };
    const r = verifyEvidence(forged, signer.publicKeyHex);
    expect(r.checks).toMatchObject({ sha256: true, keccak256: true, signature: false });
  });

  it("a bundle signed by another key fails against the trusted key, even with its embedded key", () => {
    const bundle = sealEvidence(payload(), other);
    expect(verifyEvidence(bundle, other.publicKeyHex).ok).toBe(true);
    const r = verifyEvidence(bundle, signer.publicKeyHex);
    expect(r.ok).toBe(false);
    expect(r.checks.keyId).toBe(false);
  });

  it("reports a malformed trusted key instead of throwing", () => {
    const r = verifyEvidence(sealEvidence(payload(), signer), "nothex");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/32 bytes/);
  });
});
