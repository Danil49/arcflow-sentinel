import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAddressEqual, type Address, type Hex, type PublicClient } from "viem";
import type { IrisMessagesResponse, RpcLog } from "@sentinel/core";
import type { IrisClient } from "../src/index.js";

const dir = fileURLToPath(new URL("../../../fixtures/base-to-arc-complete/", import.meta.url));
const load = (f: string) => JSON.parse(readFileSync(dir + f, "utf8"));
export const sourceReceipt = load("source-receipt.json");
export const destinationReceipt = load("destination-receipt.json");
export const iris = load("iris-messages.json") as IrisMessagesResponse;
export const SRC = sourceReceipt.transactionHash as Hex;
export const DST = destinationReceipt.transactionHash as Hex;
export const NONCE = "0x1f73af1b2ee099c698d297119d9f995d70d1682f9247bc5bbb516f8114fe68b5" as Hex;

export interface FakeChainOptions {
  head: bigint;
  receipts?: Record<string, unknown>;
  logs?: RpcLog[];
  /** Override block hashes (default: deterministic from number). */
  blockHash?: (n: bigint) => Hex;
  /** Throw from getLogs on the given call number (1-based) to simulate a crash. */
  failGetLogsOnCall?: number;
}

export const defaultHash = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;

/**
 * Minimal PublicClient fake: block timestamp == block number; logs filtered by range/address;
 * usedNonces(nonce) flips to 1 at the block of the matching MessageReceived log.
 */
export function fakeChain(o: FakeChainOptions) {
  const hashOf = o.blockHash ?? defaultHash;
  const logs = o.logs ?? [];
  const usedAt = new Map(
    logs.filter((l) => l.topics.length === 4).map((l) => [l.topics[2], BigInt(l.blockNumber)]),
  );
  const state = { head: o.head, getLogsCalls: 0 };
  const client = {
    request: async ({ params }: { params: [Hex] }) => o.receipts?.[params[0]] ?? null,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: blockNumber,
      hash: hashOf(blockNumber),
    }),
    getBlockNumber: async () => state.head,
    readContract: async ({ args, blockNumber }: { args: [Hex]; blockNumber: bigint }) => {
      const at = usedAt.get(args[0]);
      return at !== undefined && blockNumber >= at ? 1n : 0n;
    },
    getLogs: async (q: { fromBlock: bigint; toBlock: bigint; address?: Address | Address[] }) => {
      state.getLogsCalls++;
      if (o.failGetLogsOnCall === state.getLogsCalls) throw new Error("simulated RPC crash");
      const addrs = q.address === undefined ? undefined : ([] as Address[]).concat(q.address);
      return logs
        .filter((l) => {
          const n = BigInt(l.blockNumber);
          return (
            n >= q.fromBlock &&
            n <= q.toBlock &&
            (!addrs || addrs.some((a) => isAddressEqual(a, l.address)))
          );
        })
        .map((l) => ({
          ...l,
          blockNumber: BigInt(l.blockNumber),
          logIndex: Number(l.logIndex),
          blockHash: hashOf(BigInt(l.blockNumber)),
        }));
    },
  } as unknown as PublicClient;
  return { client, state };
}

/** Moves every log of a receipt to block `n` (fake chains use synthetic block numbers). */
export const logsAt = (receipt: { logs: RpcLog[] }, n: bigint): RpcLog[] =>
  receipt.logs.map((l) => ({
    ...l,
    blockNumber: `0x${n.toString(16)}` as Hex,
    blockHash: defaultHash(n),
  }));

export const receiptAt = (receipt: { logs: RpcLog[] }, n: bigint) => ({
  ...receipt,
  blockNumber: `0x${n.toString(16)}`,
  logs: logsAt(receipt, n),
});

export const staticIris = (...responses: (IrisMessagesResponse | null)[]): IrisClient => {
  let i = 0;
  return { getMessages: async () => responses[Math.min(i++, responses.length - 1)] ?? null };
};
