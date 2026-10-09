import type { Hex } from "viem";
import {
  DEFAULT_DEADLINES,
  parseIrisMessages,
  reduceLifecycle,
  type BurnObserved,
  type LifecycleResult,
  type LifecycleState,
  type StageDeadlines,
} from "@sentinel/core";
import type { StageDeadlinesOverride } from "@sentinel/config";
import {
  confirmApplication,
  enqueueJob,
  findReceivedEventByNonce,
  getTrace,
  insertAttestation,
  insertEvents,
  linkTxEvents,
  loadTraceFacts,
  saveLifecycle,
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
import { webhookOutbox, type WebhookConfig } from "./webhooks.js";

export const TRACE_REFRESH = "trace.refresh";

export interface TraceRefreshPayload {
  traceId: string;
  /** Selects the route direction (source domain) when the job is handled. */
  sourceDomain: number;
  /** Destination blocks below this are known not to contain the mint. */
  destinationFromBlock?: string;
}

export interface PollIntervals {
  attestation: number;
  destination: number;
  /** While STUCK or awaiting application confirmation: slower, but keep watching. */
  slow: number;
}

export interface PipelineDeps {
  db: Db;
  source: RouteSide;
  destination: RouteSide;
  iris: IrisClient;
  now?: () => Date;
  deadlines?: StageDeadlines;
  webhooks?: WebhookConfig | null;
  pollMs?: Partial<PollIntervals>;
  /** Stop polling a non-terminal trace this long after its burn (it stays STUCK). */
  maxTrackingMs?: number;
}

const DEFAULT_POLL: PollIntervals = { attestation: 30_000, destination: 15_000, slow: 5 * 60_000 };
const DEFAULT_MAX_TRACKING_MS = 7 * 24 * 60 * 60_000;

export const refreshKey = (traceId: string) => `${TRACE_REFRESH}:${traceId}`;

/** Applies minute-based env overrides on top of the default deadlines. */
export function resolveDeadlines(override: StageDeadlinesOverride | undefined): StageDeadlines {
  if (!override) return DEFAULT_DEADLINES;
  const ms = (m: number | undefined) => (m === undefined ? undefined : m * 60_000);
  const pick = <T>(v: T | undefined, d: T) => (v === undefined ? d : v);
  return {
    indexing: pick(ms(override.indexing), DEFAULT_DEADLINES.indexing),
    finality: {
      standard: pick(ms(override.finality?.standard), DEFAULT_DEADLINES.finality.standard),
      fast: pick(ms(override.finality?.fast), DEFAULT_DEADLINES.finality.fast),
    },
    // Explicit finality overrides apply to every source chain.
    finalityBySourceDomain: override.finality ? {} : DEFAULT_DEADLINES.finalityBySourceDomain,
    attestation: pick(ms(override.attestation), DEFAULT_DEADLINES.attestation),
    mint: pick(ms(override.mint), DEFAULT_DEADLINES.mint),
    mintEvent: pick(ms(override.mintEvent), DEFAULT_DEADLINES.mintEvent),
    applicationConfirmation: pick(
      ms(override.applicationConfirmation),
      DEFAULT_DEADLINES.applicationConfirmation,
    ),
  };
}

export interface CreateTraceOptions {
  requireAppConfirmation?: boolean;
}

/**
 * Idempotent entry point for POST /api/traces and the collector: reads the source tx, stores one
 * trace per burn plus its source events, and schedules refreshing. Calling it again for the same
 * tx returns the existing traces.
 */
export async function createTraces(
  deps: PipelineDeps,
  sourceTxHash: Hex,
  opts: CreateTraceOptions = {},
): Promise<{ traces: TraceRow[]; created: boolean }> {
  const { events, burns } = await observeSourceTx(
    deps.source,
    sourceTxHash,
    deps.destination.config.domain,
  );
  const block = await deps.source.client.getBlock({ blockNumber: burns[0]!.blockNumber });
  const sourceBlockTime = new Date(Number(block.timestamp) * 1000);

  return deps.db.transaction(async (tx) => {
    const traces: TraceRow[] = [];
    let created = false;
    for (const burn of burns) {
      const r = await upsertTraceFromBurn(tx, burn, "SOURCE_OBSERVED", {
        sourceBlockTime,
        requireAppConfirmation: opts.requireAppConfirmation ?? false,
      });
      if (r.created) {
        created = true;
        await insertEvents(tx, eventsForBurn(events, burn), r.trace.id);
        await enqueueJob(
          tx,
          TRACE_REFRESH,
          { traceId: r.trace.id, sourceDomain: burn.domain },
          { dedupeKey: refreshKey(r.trace.id) },
        );
      }
      traces.push(r.trace);
    }
    return { traces, created };
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

/**
 * Re-derives a trace's status from stored evidence (no network calls). With `persist`, saves it
 * and emits a webhook on change; without, it only tells the caller what evidence is missing.
 */
export async function reevaluateTrace(
  deps: Pick<PipelineDeps, "db" | "now" | "deadlines" | "webhooks">,
  traceId: string,
  opts: { persist?: boolean } = { persist: true },
): Promise<{ trace: TraceRow; result: LifecycleResult }> {
  const trace = await getTrace(deps.db, traceId);
  if (!trace) throw new Error(`trace ${traceId} not found`);
  const facts = await loadTraceFacts(deps.db, trace);
  const result = reduceLifecycle(
    facts.ctx,
    facts.events,
    (deps.now ?? (() => new Date()))(),
    deps.deadlines ?? DEFAULT_DEADLINES,
  );
  if (opts.persist !== false) {
    await saveLifecycle(deps.db, traceId, result, webhookOutbox(deps.webhooks ?? null));
  }
  return { trace, result };
}

export type RefreshOutcome =
  | { kind: "done"; status: LifecycleState }
  | { kind: "wait"; status: LifecycleState; delayMs: number; payload: TraceRefreshPayload };

const STAGE_RANK = (s: LifecycleState) =>
  ["SOURCE_OBSERVED", "FINALITY_WAIT", "ATTESTATION_PENDING", "ATTESTED"].indexOf(s);

/**
 * One refresh step: fetch whatever evidence the current stage is waiting for, then re-derive the
 * status with the pure reducer and persist it. Status is persisted only after fetching, so a trace
 * submitted late (old burn, no evidence stored yet) is never reported STUCK before we have looked.
 * Every write is idempotent, so running it repeatedly or concurrently with the collector is safe.
 */
export async function refreshTrace(
  deps: PipelineDeps,
  payload: TraceRefreshPayload,
): Promise<RefreshOutcome> {
  const now = deps.now ?? (() => new Date());
  const poll = { ...DEFAULT_POLL, ...deps.pollMs };
  const before = await reevaluateTrace(deps, payload.traceId, { persist: false });
  const trace = before.trace;
  let next = payload;

  // Waiting for an attestation: poll Iris.
  const rank = STAGE_RANK(before.result.progress);
  if (!before.result.terminal && rank >= 0 && rank < STAGE_RANK("ATTESTED")) {
    const sourceTxHash = trace.sourceTxHash as Hex;
    const response = await deps.iris.getMessages(trace.sourceDomain, sourceTxHash);
    if (response) {
      const attestations = parseIrisMessages(response, trace.sourceDomain, sourceTxHash, now());
      const match = matchAttestation(attestations, {
        destinationDomain: trace.destinationDomain,
        amount: trace.amountAtomic,
        mintRecipient: pad32(trace.recipient),
      });
      if (match) await insertAttestation(deps.db, trace.id, match, response);
    }
  }

  // Attested: find the destination completion (collector may already have it).
  const mid = await reevaluateTrace(deps, trace.id, { persist: false });
  if (mid.result.progress === "ATTESTED" && mid.result.nonce) {
    const destChainId = deps.destination.config.chain.id;
    const known = await findReceivedEventByNonce(deps.db, destChainId, mid.result.nonce);
    if (known) {
      await linkTxEvents(deps.db, trace.id, destChainId, known.txHash);
    } else {
      const fromBlock = payload.destinationFromBlock
        ? BigInt(payload.destinationFromBlock)
        : await destinationSearchStart(deps.source, deps.destination, trace.sourceBlockNumber);
      const lookup = await findDestination(deps.destination, mid.result.nonce, fromBlock);
      if (lookup.found) {
        await deps.db.transaction(async (tx) => {
          await insertEvents(tx, lookup.found!.events, trace.id);
          await linkTxEvents(tx, trace.id, destChainId, lookup.found!.txHash);
        });
      } else {
        next = { ...payload, destinationFromBlock: (lookup.searchedTo + 1n).toString() };
      }
    }
  }

  const { result } = await reevaluateTrace(deps, trace.id);
  if (result.terminal) return { kind: "done", status: result.status };

  const startedAt = (trace.sourceBlockTime ?? trace.firstSeenAt).getTime();
  if (now().getTime() - startedAt > (deps.maxTrackingMs ?? DEFAULT_MAX_TRACKING_MS)) {
    return { kind: "done", status: result.status }; // give up polling; status stays as derived
  }

  const delayMs =
    result.reason === "STUCK" || result.progress === "MINT_CONFIRMED"
      ? poll.slow
      : STAGE_RANK(result.progress) >= 0 && STAGE_RANK(result.progress) < STAGE_RANK("ATTESTED")
        ? poll.attestation
        : poll.destination;
  return { kind: "wait", status: result.status, delayMs, payload: next };
}

/**
 * Records the integrating application's confirmation and re-derives the status immediately
 * (no network calls). Returns null if the trace does not exist.
 */
export async function confirmTrace(
  deps: Pick<PipelineDeps, "db" | "now" | "deadlines" | "webhooks">,
  traceId: string,
  reference: string | null,
): Promise<LifecycleResult | null> {
  const row = await confirmApplication(
    deps.db,
    traceId,
    reference,
    (deps.now ?? (() => new Date()))(),
  );
  if (!row) return null;
  return (await reevaluateTrace(deps, traceId)).result;
}

const pad32 = (address: string): Hex => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
