import type { Hex } from "viem";
import {
  parseIrisMessages,
  type AttestationObserved,
  type ChainEvent,
  type IrisMessagesResponse,
  type LifecycleState,
} from "@sentinel/core";
import type { IrisClient } from "./iris.js";
import {
  destinationSearchStart,
  findDestination,
  matchAttestation,
  observeSourceTx,
  type RouteSide,
  type RpcReceipt,
} from "./steps.js";

export interface TraceOnceDeps {
  source: RouteSide;
  destination: RouteSide;
  iris: IrisClient;
  now?: () => Date;
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

/** Stateless one-shot trace of the first burn in a source tx (used by the trace-once CLI). */
export async function traceOnce(sourceTxHash: Hex, deps: TraceOnceDeps): Promise<TraceOnceResult> {
  const { source, destination } = deps;
  const now = deps.now ?? (() => new Date());

  const { receipt, events, burns } = await observeSourceTx(
    source,
    sourceTxHash,
    destination.config.domain,
  );
  const burn = burns[0]!;

  const iris = await deps.iris.getMessages(source.config.domain, sourceTxHash);
  const attestations = iris
    ? parseIrisMessages(iris, source.config.domain, sourceTxHash, now())
    : [];
  const match = matchAttestation(attestations, burn);
  const attested = match?.status === "complete" && match.nonce ? match : undefined;

  const result: TraceOnceResult = {
    status: !iris ? "SOURCE_OBSERVED" : attested ? "ATTESTED" : "FINALITY_WAIT",
    sourceEvents: events,
    attestations,
    destinationTxHash: null,
    destinationEvents: [],
    raw: { sourceReceipt: receipt, iris, destinationReceipt: null },
  };
  if (!attested) return result;

  const fromBlock = await destinationSearchStart(source, destination, burn.blockNumber);
  const { found } = await findDestination(destination, attested.nonce!, fromBlock);
  if (!found) return result;

  result.destinationTxHash = found.txHash;
  result.raw.destinationReceipt = found.receipt;
  result.destinationEvents = found.events;
  const minted = found.events.some((e) => e.kind === "mint");
  result.status =
    found.receipt.status === "0x1" && minted ? "MINT_CONFIRMED" : "DESTINATION_SUBMITTED";
  return result;
}
