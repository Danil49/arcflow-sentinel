import type { Hex, PublicClient } from "viem";
import {
  decodeCctpLogs,
  fromRpcLog,
  messageTransmitterV2Abi,
  type AttestationObserved,
  type BurnObserved,
  type ChainEvent,
  type RpcLog,
} from "@sentinel/core";
import { findBlockAtOrAfter, findNonceUsedBlock, type RouteChainConfig } from "@sentinel/chains";

export interface RouteSide {
  config: RouteChainConfig;
  client: PublicClient;
}

export interface RpcReceipt {
  status: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logs: RpcLog[];
}

const messageReceivedEvent = messageTransmitterV2Abi.find(
  (e) => e.type === "event" && e.name === "MessageReceived",
)!;

export const getRawReceipt = (client: PublicClient, hash: Hex) =>
  client.request({
    method: "eth_getTransactionReceipt",
    params: [hash],
  }) as Promise<RpcReceipt | null>;

const decodeReceipt = (side: RouteSide, receipt: RpcReceipt) =>
  decodeCctpLogs(
    receipt.logs.map((l) => fromRpcLog(l, side.config.chain.id)),
    side.config,
  );

export class TraceInputError extends Error {
  override name = "TraceInputError";
}

/** Reads a source tx and returns its CCTP events. Throws TraceInputError for bad user input. */
export async function observeSourceTx(source: RouteSide, txHash: Hex, destinationDomain: number) {
  const receipt = await getRawReceipt(source.client, txHash);
  if (!receipt) throw new TraceInputError(`tx ${txHash} not found on ${source.config.key}`);
  if (receipt.status !== "0x1") throw new TraceInputError(`tx ${txHash} reverted`);
  const events = decodeReceipt(source, receipt);
  const burns = events.filter((e): e is BurnObserved => e.kind === "burn");
  if (burns.length === 0) throw new TraceInputError(`no CCTP V2 DepositForBurn in ${txHash}`);
  const offRoute = burns.find((b) => b.destinationDomain !== destinationDomain);
  if (offRoute) {
    throw new TraceInputError(
      `burn targets domain ${offRoute.destinationDomain}, expected ${destinationDomain}`,
    );
  }
  return { receipt, events, burns };
}

/**
 * Picks the Iris message belonging to a burn. A tx usually has one burn; when it has several,
 * match on the fields both sides carry rather than relying on response order.
 */
export function matchAttestation(
  attestations: readonly AttestationObserved[],
  burn: Pick<BurnObserved, "destinationDomain" | "amount" | "mintRecipient">,
): AttestationObserved | undefined {
  const matching = attestations.filter(
    (a) =>
      !a.message ||
      (a.message.destinationDomain === burn.destinationDomain &&
        a.message.body.amount === burn.amount &&
        a.message.body.mintRecipient.toLowerCase() === burn.mintRecipient.toLowerCase()),
  );
  return matching.find((a) => a.message) ?? matching[0];
}

/** First destination block worth searching: mints cannot precede the burn. */
export async function destinationSearchStart(
  source: RouteSide,
  destination: RouteSide,
  sourceBlockNumber: bigint,
): Promise<bigint> {
  const block = await source.client.getBlock({ blockNumber: sourceBlockNumber });
  return findBlockAtOrAfter(destination.client, block.timestamp);
}

export interface DestinationLookup {
  /** Highest block known not to contain the receipt when not found; search from here + 1 next time. */
  searchedTo: bigint;
  found: { txHash: Hex; receipt: RpcReceipt; events: ChainEvent[] } | null;
}

/** Locates the tx that consumed `nonce` via usedNonces, then reads its receipt. */
export async function findDestination(
  destination: RouteSide,
  nonce: Hex,
  fromBlock: bigint,
): Promise<DestinationLookup> {
  const head = await destination.client.getBlockNumber();
  if (fromBlock > head) return { searchedTo: head, found: null };
  const usedAt = await findNonceUsedBlock(
    destination.client,
    destination.config.messageTransmitter,
    nonce,
    fromBlock,
    head,
  );
  if (usedAt === null) return { searchedTo: head, found: null };

  const [log] = await destination.client.getLogs({
    address: destination.config.messageTransmitter,
    event: messageReceivedEvent,
    args: { nonce },
    fromBlock: usedAt,
    toBlock: usedAt,
  });
  if (!log?.transactionHash) {
    throw new Error(`usedNonces says ${nonce} was used at ${usedAt} but no MessageReceived found`);
  }
  const receipt = await getRawReceipt(destination.client, log.transactionHash);
  if (!receipt) throw new Error(`receipt ${log.transactionHash} not available yet`);
  return {
    searchedTo: usedAt,
    found: { txHash: log.transactionHash, receipt, events: decodeReceipt(destination, receipt) },
  };
}
