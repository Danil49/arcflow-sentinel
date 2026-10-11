import { createEVM } from "@ethereumjs/evm";
import { Address, bytesToHex, createAccount, hexToBytes } from "@ethereumjs/util";
import { formatAbi } from "abitype";
import { decodeEventLog, encodeFunctionData, keccak256, toHex, type Abi, type Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import {
  anchorStatusCode,
  ANCHOR_STATUS,
  evidenceRegistryAbi,
  evidenceRegistryArtifact,
  evidenceRegistryBytecode,
  traceIdToBytes32,
} from "../src/index.js";
import { compileRegistry } from "../src/compile.js";

const caller = new Address(hexToBytes("0x6f696845ba4e28436d48fdc023c19e849e8154fc"));
let evm: Awaited<ReturnType<typeof createEVM>>;
let registry: Address;

beforeAll(async () => {
  evm = await createEVM();
  const res = await evm.runCall({
    caller,
    data: hexToBytes(evidenceRegistryBytecode),
    gasLimit: 1_000_000n,
  });
  expect(res.execResult.exceptionError).toBeUndefined();
  registry = res.createdAddress!;
});

async function call(data: Hex, value = 0n) {
  return evm.runCall({ caller, to: registry, data: hexToBytes(data), gasLimit: 100_000n, value });
}

const TRACE = "f66ba840-24fe-4821-b152-0d6dc0c8c957";
const HASH = keccak256(toHex("bundle"));

describe("EvidenceRegistry", () => {
  it("anchor emits EvidenceAnchored with every field and msg.sender", async () => {
    const data = encodeFunctionData({
      abi: evidenceRegistryAbi,
      functionName: "anchor",
      args: [traceIdToBytes32(TRACE), HASH, ANCHOR_STATUS.MINT_CONFIRMED, 1_760_000_000n],
    });
    const res = await call(data);
    expect(res.execResult.exceptionError).toBeUndefined();
    const logs = res.execResult.logs ?? [];
    expect(logs).toHaveLength(1);
    const [address, topics, logData] = logs[0]!;
    expect(bytesToHex(address)).toBe(registry.toString());
    const decoded = decodeEventLog({
      abi: evidenceRegistryAbi,
      topics: topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
      data: bytesToHex(logData),
    });
    expect(decoded).toEqual({
      eventName: "EvidenceAnchored",
      args: {
        traceId: traceIdToBytes32(TRACE),
        evidenceHash: HASH,
        status: 6,
        observedAt: 1_760_000_000n,
        submitter: "0x6f696845ba4e28436d48FDc023C19E849e8154fc",
      },
    });
    expect(Number(res.execResult.executionGasUsed)).toBeLessThan(5_000);
  });

  it("stores nothing and rejects value (non-payable)", async () => {
    const data = encodeFunctionData({
      abi: evidenceRegistryAbi,
      functionName: "anchor",
      args: [traceIdToBytes32(TRACE), HASH, 1, 1n],
    });
    await call(data);
    const storage = await evm.stateManager.dumpStorage?.(registry);
    expect(Object.keys(storage ?? {})).toHaveLength(0);
    // Fund the caller, so a failure below can only come from the contract refusing value.
    await evm.stateManager.putAccount(caller, createAccount({ balance: 10n ** 18n }));
    expect((await call(data, 0n)).execResult.exceptionError).toBeUndefined();
    const paid = await call(data, 1n);
    expect(paid.execResult.exceptionError?.error).toBe("revert");
  });

  it("reverts on unknown selectors and malformed calldata", async () => {
    expect((await call("0xdeadbeef")).execResult.exceptionError).toBeDefined();
    expect(
      (
        await call(
          encodeFunctionData({
            abi: evidenceRegistryAbi,
            functionName: "anchor",
            args: [traceIdToBytes32(TRACE), HASH, 1, 1n],
          }).slice(0, 40) as Hex,
        )
      ).execResult.exceptionError,
    ).toBeDefined();
  });
});

describe("artifact and helpers", () => {
  it("committed artifact matches a fresh compile of the source", () => {
    const fresh = compileRegistry();
    expect(fresh.bytecode).toBe(evidenceRegistryArtifact.bytecode);
    expect(fresh.sourceSha256).toBe(evidenceRegistryArtifact.sourceSha256);
    expect(fresh.abi).toEqual(evidenceRegistryArtifact.abi);
  });

  it("typed ABI equals the compiled ABI", () => {
    const sigs = (abi: readonly unknown[]) => [...formatAbi(abi as Abi)].sort();
    expect(sigs(evidenceRegistryAbi)).toEqual(sigs(evidenceRegistryArtifact.abi));
  });

  it("maps statuses to stable codes and trace ids to bytes32", () => {
    expect(anchorStatusCode("MINT_CONFIRMED", null)).toBe(6);
    expect(anchorStatusCode("FAILED_OR_STUCK", "FAILED")).toBe(8);
    expect(anchorStatusCode("FAILED_OR_STUCK", "STUCK")).toBe(9);
    expect(anchorStatusCode("WHATEVER", null)).toBe(0);
    expect(traceIdToBytes32(TRACE)).toBe(
      "0xf66ba84024fe4821b1520d6dc0c8c95700000000000000000000000000000000",
    );
    expect(() => traceIdToBytes32("nope")).toThrow();
  });
});
