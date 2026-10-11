import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { evidenceRegistryAbi, traceIdToBytes32 } from "@sentinel/contracts";
import {
  EVIDENCE_SCHEMA,
  sealEvidence,
  signerFromSeed,
  verifyAnchor,
  type EvidencePayload,
} from "../src/index.js";

const REGISTRY = "0xD37a99DC7a7CA2E3b1A75648886875E50a6b52FF" as Address;
const OPERATOR = "0x6f696845ba4e28436d48FDc023C19E849e8154fc" as Address;
const STRANGER = "0x000000000000000000000000000000000000bEEF" as Address;
const TX = `0x${"aa".repeat(32)}` as Hex;

const payload: EvidencePayload = {
  schema: EVIDENCE_SCHEMA,
  network: "mainnet",
  trace: {
    id: "c7a683bb-c2b1-4418-9a48-5200939f60f2",
    sourceDomain: 26,
    destinationDomain: 6,
    sourceChainId: 5042,
    sourceTxHash: "0xf2",
    sourceLogIndex: 11,
    sourceBlockNumber: "1",
    sourceBlockTime: null,
    nonce: null,
    sender: "0x1",
    recipient: "0x2",
    amountAtomic: "1",
    destinationTxHash: null,
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
  invariants: [],
  observations: { chainEvents: [], attestations: [] },
};
const bundle = sealEvidence(payload, signerFromSeed("44".repeat(32)));

function client(
  log: { address: Address; submitter: Address; hash?: Hex; traceId?: Hex },
  status: "success" | "reverted" = "success",
) {
  return {
    getChainId: async () => 5042002,
    getTransactionReceipt: async () => ({
      status,
      blockNumber: 7n,
      logs: [
        {
          address: log.address,
          topics: encodeEventTopics({
            abi: evidenceRegistryAbi,
            eventName: "EvidenceAnchored",
            args: {
              traceId: log.traceId ?? traceIdToBytes32(payload.trace.id),
              evidenceHash: log.hash ?? bundle.hashes.keccak256,
              submitter: log.submitter,
            },
          }),
          data: encodeAbiParameters([{ type: "uint8" }, { type: "uint64" }], [6, 1n]),
        },
      ],
    }),
  } as never;
}

const check = (c: ReturnType<typeof client>, submitter?: Address) =>
  verifyAnchor(bundle, {
    txHash: TX,
    registry: REGISTRY,
    chainId: 5042002,
    client: c,
    ...(submitter ? { submitter } : {}),
  });

describe("verifyAnchor", () => {
  it("accepts the operator's anchor of the recomputed hash", async () => {
    const r = await check(client({ address: REGISTRY, submitter: OPERATOR }), OPERATOR);
    expect(r).toMatchObject({
      ok: true,
      errors: [],
      checks: { submitterMatches: true },
      blockNumber: 7n,
    });
  });

  it("rejects an anchor someone else submitted through the permissionless registry", async () => {
    const r = await check(client({ address: REGISTRY, submitter: STRANGER }), OPERATOR);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/submitted by .* not the operator/);
  });

  it("rejects lookalike events from another contract, other traces, other hashes, reverts", async () => {
    expect(
      (await check(client({ address: STRANGER, submitter: OPERATOR }))).checks.emittedByRegistry,
    ).toBe(false);
    expect(
      (
        await check(
          client({ address: REGISTRY, submitter: OPERATOR, traceId: `0x${"11".repeat(32)}` }),
        )
      ).checks.traceIdMatches,
    ).toBe(false);
    expect(
      (
        await check(
          client({ address: REGISTRY, submitter: OPERATOR, hash: `0x${"22".repeat(32)}` }),
        )
      ).checks.hashMatches,
    ).toBe(false);
    expect((await check(client({ address: REGISTRY, submitter: OPERATOR }, "reverted"))).ok).toBe(
      false,
    );
  });

  it("without an expected submitter, does not claim to have checked it", async () => {
    const r = await check(client({ address: REGISTRY, submitter: STRANGER }));
    expect(r.ok).toBe(true);
    expect(r.checks.submitterMatches).toBeUndefined();
  });
});
