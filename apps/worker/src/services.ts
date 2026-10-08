import type { Hex } from "viem";
import {
  advanceState,
  parseIrisMessages,
  type BurnObserved,
  type LifecycleState,
} from "@sentinel/core";
import {
  enqueueJob,
  findReceivedEventByNonce,
  getTrace,
  getTraceEvents,
  insertAttestation,
  insertEvents,
  linkTxEvents,
  updateTrace,
  upsertTraceFromBurn,
  type Db,
  type TraceRow,
} from "@sentinel/db";
import type { IrisClient } from "./iris.js";
import {
  destinationSearchStart,
  findDestination,
  matchAttestation,
  observeSourceTx,
  type RouteSide,
} from "./steps.js";

export const TRACE_REFRESH = "trace.refresh";

export interface TraceRefreshPayload {
  traceId: string;
  /** Selects the route direction (source domain) when the job is handled. */
  sourceDomain: number;
  /** Destination blocks below this are known not to contain the mint. */
  destinationFromBlock?: string;
}

export interface PipelineDeps {
  db: Db;
  source: RouteSide;
  destination: RouteSide;
  iris: IrisClient;
  now?: () => Date;
  /** Poll intervals while waiting on Iris / the destination chain. */
  pollMs?: { attestation: number; destination: number };
}

const DEFAULT_POLL = { attestation: 30_000, destination: 15_000 };

const refreshKey = (traceId: string) => `${TRACE_REFRESH}:${traceId}`;

/**
 * Idempotent entry point for POST /api/traces and the collector: reads the source tx, stores one
 * trace per burn plus its source events, and schedules refreshing. Calling it again for the same
 * tx returns the existing traces.
 */
export async function createTraces(deps: PipelineDeps, sourceTxHash: Hex): Promise<TraceRow[]> {
  const { events, burns } = await observeSourceTx(
    deps.source,
    sourceTxHash,
    deps.destination.config.domain,
  );
  return deps.db.transaction(async (tx) => {
    const traces: TraceRow[] = [];
    for (const burn of burns) {
      const { trace, created } = await upsertTraceFromBurn(tx, burn, "SOURCE_OBSERVED");
      if (created) {
        await insertEvents(tx, eventsForBurn(events, burn), trace.id);
        await enqueueJob(
          tx,
          TRACE_REFRESH,
          { traceId: trace.id, sourceDomain: burn.domain },
          { dedupeKey: refreshKey(trace.id) },
        );
      }
      traces.push(trace);
    }
    return traces;
  });
}

/** Events in the source tx that belong to this burn: the burn itself and its MessageSent. */
function eventsForBurn(
  events: Awaited<ReturnType<typeof observeSourceTx>>["events"],
  burn: BurnObserved,
) {
  // TokenMessengerV2 emits MessageSent (from MessageTransmitterV2) immediately before
  // DepositForBurn in the same call, so the closest preceding MessageSent is this burn's.
  const sent = events
    .filter((e) => e.kind === "message_sent" && e.logIndex < burn.logIndex)
    .sort((a, b) => b.logIndex - a.logIndex)[0];
  return sent ? [burn, sent] : [burn];
}

export type RefreshOutcome =
  | { kind: "done"; status: LifecycleState }
  | { kind: "wait"; status: LifecycleState; delayMs: number; payload: TraceRefreshPayload };

/**
 * Advances one trace as far as currently observable. Safe to run repeatedly and concurrently with
 * the collector: every write is an idempotent upsert and status only moves forward.
 */
export async function refreshTrace(
  deps: PipelineDeps,
  payload: TraceRefreshPayload,
): Promise<RefreshOutcome> {
  const now = deps.now ?? (() => new Date());
  const poll = deps.pollMs ?? DEFAULT_POLL;
  const trace = await getTrace(deps.db, payload.traceId);
  if (!trace) throw new Error(`trace ${payload.traceId} not found`);
  let status = trace.status as LifecycleState;
  const setStatus = async (next: LifecycleState) => {
    const advanced = advanceState(status, next);
    if (advanced !== status) await updateTrace(deps.db, trace.id, { status: advanced });
    status = advanced;
  };

  // 1. Attestation: learn the nonce from Iris.
  let nonce = trace.messageNonce as Hex | null;
  if (!nonce) {
    const sourceTxHash = trace.sourceTxHash as Hex;
    const response = await deps.iris.getMessages(trace.sourceDomain, sourceTxHash);
    if (!response) return { kind: "wait", status, delayMs: poll.attestation, payload };

    const attestations = parseIrisMessages(response, trace.sourceDomain, sourceTxHash, now());
    const match = matchAttestation(attestations, {
      destinationDomain: trace.destinationDomain,
      amount: trace.amountAtomic,
      mintRecipient: pad32(trace.recipient),
    });
    if (match) await insertAttestation(deps.db, trace.id, match, response);
    if (match?.status !== "complete" || !match.nonce) {
      await setStatus(match ? "FINALITY_WAIT" : "ATTESTATION_PENDING");
      return { kind: "wait", status, delayMs: poll.attestation, payload };
    }
    nonce = match.nonce;
    await updateTrace(deps.db, trace.id, { messageNonce: nonce });
    await setStatus("ATTESTED");
  }

  // 2. Destination: reuse a MessageReceived the collector already stored, else look it up.
  const destChainId = deps.destination.config.chain.id;
  const known = await findReceivedEventByNonce(deps.db, destChainId, nonce);
  if (known) {
    await linkTxEvents(deps.db, trace.id, destChainId, known.txHash);
  } else {
    const fromBlock = payload.destinationFromBlock
      ? BigInt(payload.destinationFromBlock)
      : await destinationSearchStart(deps.source, deps.destination, trace.sourceBlockNumber);
    const lookup = await findDestination(deps.destination, nonce, fromBlock);
    if (!lookup.found) {
      return {
        kind: "wait",
        status,
        delayMs: poll.destination,
        payload: { ...payload, destinationFromBlock: (lookup.searchedTo + 1n).toString() },
      };
    }
    await deps.db.transaction(async (tx) => {
      await insertEvents(tx, lookup.found!.events, trace.id);
      await linkTxEvents(tx, trace.id, destChainId, lookup.found!.txHash);
    });
  }

  await setStatus("DESTINATION_SUBMITTED");
  const minted = (await getTraceEvents(deps.db, trace.id)).some(
    (e) => e.eventType === "mint" && !e.removed,
  );
  if (minted) await setStatus("MINT_CONFIRMED");
  return { kind: "done", status };
}

const pad32 = (address: string): Hex => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

export { refreshKey };
