import type { Hex, PublicClient } from "viem";
import {
  decodeCctpLogs,
  fromRpcLog,
  messageTransmitterV2Abi,
  parseIrisMessages,
  type AttestationObserved,
  type ChainEvent,
  type IrisMessagesResponse,
  type LifecycleState,
  type RpcLog,
} from "@sentinel/core";
import { findBlockAtOrAfter, findNonceUsedBlock, type RouteChainConfig } from "@sentinel/chains";
import type { IrisClient } from "./iris.js";

export interface RouteSide {
  config: RouteChainConfig;
  client: PublicClient;
}

export interface TraceOnceDeps {
  source: RouteSide;
  destination: RouteSide;
  iris: IrisClient;
  now?: () => Date;
}

interface RpcReceipt {
  status: Hex;
  blockNumber: Hex;
  logs: RpcLog[];
}

export interface TraceOnceResult {
  /** Coarse status for the spike only; replaced by the lifecycle reducer in Phase 3. */
  status: LifecycleState;
  sourceEvents: ChainEvent[];
  attestations: AttestationObserved[];
  destinationTxHash: Hex | null;
  destinationEvents: ChainEvent[];
  raw: {
    sourceReceipt: RpcReceipt;
    iris: IrisMessagesResponse | null;
    destinationReceipt: RpcReceipt | null;
  };
}

const messageReceivedEvent = messageTransmitterV2Abi.find(
  (e) => e.type === "event" && e.name === "MessageReceived",
)!;

const getRawReceipt = (client: PublicClient, hash: Hex) =>
  client.request({
    method: "eth_getTransactionReceipt",
    params: [hash],
  }) as Promise<RpcReceipt | null>;

export async function traceOnce(sourceTxHash: Hex, deps: TraceOnceDeps): Promise<TraceOnceResult> {
  const { source, destination } = deps;
  const now = deps.now ?? (() => new Date());

  const sourceReceipt = await getRawReceipt(source.client, sourceTxHash);
  if (!sourceReceipt)
    throw new Error(`source tx ${sourceTxHash} not found on ${source.config.key}`);
  if (sourceReceipt.status !== "0x1") throw new Error(`source tx ${sourceTxHash} reverted`);

  const sourceEvents = decodeCctpLogs(
    sourceReceipt.logs.map((l) => fromRpcLog(l, source.config.chain.id)),
    source.config,
  );
  const burn = sourceEvents.find((e) => e.kind === "burn");
  if (!burn) throw new Error(`no CCTP V2 DepositForBurn in ${sourceTxHash}`);
  if (burn.destinationDomain !== destination.config.domain) {
    throw new Error(
      `burn targets domain ${burn.destinationDomain}, expected ${destination.config.domain} (${destination.config.key})`,
    );
  }

  const iris = await deps.iris.getMessages(source.config.domain, sourceTxHash);
  const attestations = iris
    ? parseIrisMessages(iris, source.config.domain, sourceTxHash, now())
    : [];
  const attestation = attestations.find((a) => a.status === "complete" && a.nonce);

  const result: TraceOnceResult = {
    status: !iris ? "SOURCE_OBSERVED" : attestation ? "ATTESTED" : "FINALITY_WAIT",
    sourceEvents,
    attestations,
    destinationTxHash: null,
    destinationEvents: [],
    raw: { sourceReceipt, iris, destinationReceipt: null },
  };
  if (!attestation) return result;

  // The nonce only exists once attested. The mint cannot precede the burn, so search the
  // destination from the source block's timestamp: binary-search usedNonces for the block that
  // consumed the nonce, then read MessageReceived from that single block.
  const sourceBlock = await source.client.getBlock({ blockNumber: burn.blockNumber });
  const fromBlock = await findBlockAtOrAfter(destination.client, sourceBlock.timestamp);
  const head = await destination.client.getBlockNumber();
  const usedAt = await findNonceUsedBlock(
    destination.client,
    destination.config.messageTransmitter,
    attestation.nonce!,
    fromBlock,
    head,
  );
  if (usedAt === null) return result;

  const [received] = await destination.client.getLogs({
    address: destination.config.messageTransmitter,
    event: messageReceivedEvent,
    args: { nonce: attestation.nonce! },
    fromBlock: usedAt,
    toBlock: usedAt,
  });
  if (!received?.transactionHash) return result;

  const destinationReceipt = await getRawReceipt(destination.client, received.transactionHash);
  if (!destinationReceipt) return result;

  result.destinationTxHash = received.transactionHash;
  result.raw.destinationReceipt = destinationReceipt;
  result.destinationEvents = decodeCctpLogs(
    destinationReceipt.logs.map((l) => fromRpcLog(l, destination.config.chain.id)),
    destination.config,
  );
  const minted = result.destinationEvents.some((e) => e.kind === "mint");
  result.status =
    destinationReceipt.status === "0x1" && minted ? "MINT_CONFIRMED" : "DESTINATION_SUBMITTED";
  return result;
}
