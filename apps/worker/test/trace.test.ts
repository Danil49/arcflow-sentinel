import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { routeChains } from "@sentinel/chains";
import type { IrisMessagesResponse } from "@sentinel/core";
import { traceOnce, type IrisClient } from "../src/index.js";

const dir = fileURLToPath(new URL("../../../fixtures/base-to-arc-complete/", import.meta.url));
const load = (f: string) => JSON.parse(readFileSync(dir + f, "utf8"));
const sourceReceipt = load("source-receipt.json");
const destinationReceipt = load("destination-receipt.json");
const iris = load("iris-messages.json") as IrisMessagesResponse;

const SRC = sourceReceipt.transactionHash as Hex;
const DST = destinationReceipt.transactionHash as Hex;
const chains = routeChains("mainnet");

/** Minimal PublicClient fake: block timestamp == block number, logs served from receipts. */
function fakeClient(receipts: Record<string, unknown>, head: bigint, logs: unknown[] = []) {
  return {
    request: async ({ params }: { params: [Hex] }) => receipts[params[0]] ?? null,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber }),
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      logs.filter((l) => {
        const n = BigInt((l as { blockNumber: Hex }).blockNumber);
        return n >= fromBlock && n <= toBlock;
      }),
  } as unknown as PublicClient;
}

const destLog = destinationReceipt.logs.find((l: { topics: Hex[] }) => l.topics.length === 4);
const irisClient = (response: IrisMessagesResponse | null): IrisClient => ({
  getMessages: async () => response,
});

const deps = (irisResponse: IrisMessagesResponse | null) => ({
  // Source block 52308155 -> timestamp 52308155; destination mint block must be >= that.
  source: { config: chains.base, client: fakeClient({ [SRC]: sourceReceipt }, 60_000_000n) },
  destination: {
    config: chains.arc,
    client: fakeClient(
      { [DST]: destinationReceipt },
      60_000_000n,
      [{ ...destLog, blockNumber: "0x31e28c0" }], // a few blocks after the source timestamp
    ),
  },
  iris: irisClient(irisResponse),
  maxDestinationBlocks: 10_000n,
});

describe("traceOnce", () => {
  it("follows a completed Base→Arc transfer to MINT_CONFIRMED", async () => {
    const r = await traceOnce(SRC, deps(iris));
    expect(r.status).toBe("MINT_CONFIRMED");
    expect(r.destinationTxHash).toBe(DST);
    expect(r.destinationEvents.map((e) => e.kind).sort()).toEqual(["message_received", "mint"]);
  });

  it("stays at SOURCE_OBSERVED when Iris has not indexed the burn", async () => {
    const r = await traceOnce(SRC, deps(null));
    expect(r.status).toBe("SOURCE_OBSERVED");
    expect(r.destinationTxHash).toBeNull();
  });

  it("reports FINALITY_WAIT while the attestation is pending", async () => {
    const r = await traceOnce(
      SRC,
      deps({
        messages: [{ status: "pending_confirmations", attestation: "PENDING", message: "0x" }],
      }),
    );
    expect(r.status).toBe("FINALITY_WAIT");
  });

  it("stays ATTESTED when no mint exists in the scanned range", async () => {
    const d = deps(iris);
    d.destination.client = fakeClient({}, 60_000_000n, []);
    const r = await traceOnce(SRC, d);
    expect(r.status).toBe("ATTESTED");
  });

  it("rejects a burn whose destination is not the configured route", async () => {
    const d = deps(iris);
    d.destination = { ...d.destination, config: chains.base };
    await expect(traceOnce(SRC, d)).rejects.toThrow(/expected 6/);
  });
});
