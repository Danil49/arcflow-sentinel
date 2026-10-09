import { and, asc, eq, sql } from "drizzle-orm";
import type { Hex } from "viem";
import {
  parseIrisMessages,
  reviveChainEvent,
  toJsonSafe,
  type DomainEvent,
  type IrisMessagesResponse,
  type LifecycleResult,
  type TraceContext,
} from "@sentinel/core";
import type { Db } from "./client.js";
import type { TraceRow, Tx } from "./repo.js";
import {
  attestationObservations,
  invariantResults,
  observedEvents,
  transferTraces,
} from "./schema.js";

export interface TraceFacts {
  ctx: TraceContext;
  events: DomainEvent[];
}

/** Everything the lifecycle reducer needs for one trace, from stored observations only. */
export async function loadTraceFacts(db: Tx, trace: TraceRow): Promise<TraceFacts> {
  const rows = await db
    .select()
    .from(observedEvents)
    .where(and(eq(observedEvents.traceId, trace.id), eq(observedEvents.removed, false)));
  const iris = await db
    .select()
    .from(attestationObservations)
    .where(eq(attestationObservations.traceId, trace.id))
    .orderBy(asc(attestationObservations.observedAt));

  const events: DomainEvent[] = rows.map((r) => reviveChainEvent(r.decoded as never, r.observedAt));
  for (const obs of iris) {
    events.push(
      ...parseIrisMessages(
        obs.rawResponse as IrisMessagesResponse,
        trace.sourceDomain,
        trace.sourceTxHash as Hex,
        obs.observedAt,
      ),
    );
  }

  return {
    ctx: {
      sourceDomain: trace.sourceDomain,
      destinationDomain: trace.destinationDomain,
      burn: {
        chainId: trace.sourceChainId,
        txHash: trace.sourceTxHash as Hex,
        logIndex: trace.sourceLogIndex,
      },
      sourceBlockTime: trace.sourceBlockTime,
      firstSeenAt: trace.firstSeenAt,
      requireApplicationConfirmation: trace.requireAppConfirmation,
      applicationConfirmedAt: trace.applicationConfirmedAt,
    },
    events,
  };
}

export interface StatusChange {
  previous: { status: string; reason: string | null };
  trace: TraceRow;
  result: LifecycleResult;
  /** Webhook sequence number allocated for this change (monotonic per trace). */
  sequence: number;
}

/**
 * Persists a reducer result. The row is locked so concurrent refreshes serialize; when the
 * reported status or reason changes, the per-trace sequence is bumped and `onStatusChange` runs
 * in the same transaction (the webhook outbox), so a change can never be saved without its
 * notification or vice versa.
 */
export async function saveLifecycle(
  db: Db,
  traceId: string,
  result: LifecycleResult,
  onStatusChange?: (tx: Tx, change: StatusChange) => Promise<void>,
): Promise<StatusChange | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(transferTraces)
      .where(eq(transferTraces.id, traceId))
      .for("update");
    if (!current) throw new Error(`trace ${traceId} not found`);

    const changed = current.status !== result.status || current.reason !== result.reason;
    const sequence = changed ? current.webhookSeq + 1 : current.webhookSeq;
    const [updated] = await tx
      .update(transferTraces)
      .set({
        status: result.status,
        progress: result.progress,
        reason: result.reason,
        statusReason: result.statusReason,
        messageNonce: result.nonce?.toLowerCase() ?? current.messageNonce,
        destinationTxHash: result.destinationTxHash?.toLowerCase() ?? null,
        stageDeadlineAt: result.deadlineAt,
        webhookSeq: sequence,
        updatedAt: new Date(),
      })
      .where(eq(transferTraces.id, traceId))
      .returning();

    await tx
      .insert(invariantResults)
      .values(
        result.invariants.map((i) => ({
          traceId,
          ruleId: i.ruleId,
          result: i.result,
          explanation: i.explanation,
          evidenceRefs: toJsonSafe(i.evidenceRefs),
        })),
      )
      .onConflictDoUpdate({
        target: [invariantResults.traceId, invariantResults.ruleId],
        set: {
          result: sql`excluded.result`,
          explanation: sql`excluded.explanation`,
          evidenceRefs: sql`excluded.evidence_refs`,
          evaluatedAt: new Date(),
        },
      });

    if (!changed) return null;
    const change: StatusChange = {
      previous: { status: current.status, reason: current.reason },
      trace: updated!,
      result,
      sequence,
    };
    await onStatusChange?.(tx, change);
    return change;
  });
}

export async function getInvariantResults(db: Tx, traceId: string) {
  return db
    .select()
    .from(invariantResults)
    .where(eq(invariantResults.traceId, traceId))
    .orderBy(asc(invariantResults.ruleId));
}

/**
 * Records the integrating application's confirmation. Idempotent: the first confirmation time and
 * reference are kept. Returns null if the trace does not exist.
 */
export async function confirmApplication(
  db: Tx,
  traceId: string,
  reference: string | null,
  at = new Date(),
): Promise<TraceRow | null> {
  const [row] = await db
    .update(transferTraces)
    .set({
      applicationConfirmedAt: sql`coalesce(${transferTraces.applicationConfirmedAt}, ${at})`,
      applicationReference: sql`coalesce(${transferTraces.applicationReference}, ${reference})`,
      updatedAt: at,
    })
    .where(eq(transferTraces.id, traceId))
    .returning();
  return row ?? null;
}
