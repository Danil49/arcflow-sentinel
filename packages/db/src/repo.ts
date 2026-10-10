import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import {
  bytes32ToAddress,
  toJsonSafe,
  type AttestationObserved,
  type BurnObserved,
  type ChainEvent,
  type LifecycleState,
} from "@sentinel/core";
import type { Db } from "./client.js";
import {
  attestationObservations,
  chainBlocks,
  chainCursors,
  observedEvents,
  transferTraces,
} from "./schema.js";

/** Accepts the root db or a transaction. */
export type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type TraceRow = typeof transferTraces.$inferSelect;
export type ObservedEventRow = typeof observedEvents.$inferSelect;

// ---- traces ---------------------------------------------------------------------------------

/** Idempotent: the same burn log always maps to the same trace. */
export interface TraceOptions {
  sourceBlockTime?: Date | null;
  /** Opt-in only: a later request can turn it on for an existing trace, never off. */
  requireAppConfirmation?: boolean;
}

export async function upsertTraceFromBurn(
  db: Tx,
  burn: BurnObserved,
  status: LifecycleState,
  opts: TraceOptions = {},
): Promise<{ trace: TraceRow; created: boolean }> {
  const [inserted] = await db
    .insert(transferTraces)
    .values({
      sourceChainId: burn.chainId,
      sourceDomain: burn.domain,
      destinationDomain: burn.destinationDomain,
      sourceTxHash: burn.txHash.toLowerCase(),
      sourceLogIndex: burn.logIndex,
      sourceBlockNumber: burn.blockNumber,
      sender: burn.depositor,
      recipient: bytes32ToAddress(burn.mintRecipient),
      amountAtomic: burn.amount,
      status,
      progress: status,
      sourceBlockTime: opts.sourceBlockTime ?? null,
      requireAppConfirmation: opts.requireAppConfirmation ?? false,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { trace: inserted, created: true };

  const [existing] = await db
    .select()
    .from(transferTraces)
    .where(
      and(
        eq(transferTraces.sourceChainId, burn.chainId),
        eq(transferTraces.sourceTxHash, burn.txHash.toLowerCase()),
        eq(transferTraces.sourceLogIndex, burn.logIndex),
      ),
    );
  if (!existing) throw new Error("trace upsert conflicted but no row found");
  if (opts.requireAppConfirmation && !existing.requireAppConfirmation) {
    const [upgraded] = await db
      .update(transferTraces)
      .set({ requireAppConfirmation: true, updatedAt: new Date() })
      .where(eq(transferTraces.id, existing.id))
      .returning();
    return { trace: upgraded!, created: false };
  }
  return { trace: existing, created: false };
}

export async function getTrace(db: Tx, id: string): Promise<TraceRow | undefined> {
  const [row] = await db.select().from(transferTraces).where(eq(transferTraces.id, id));
  return row;
}

export async function findTracesBySourceTx(
  db: Tx,
  sourceChainId: number,
  sourceTxHash: string,
): Promise<TraceRow[]> {
  return db
    .select()
    .from(transferTraces)
    .where(
      and(
        eq(transferTraces.sourceChainId, sourceChainId),
        eq(transferTraces.sourceTxHash, sourceTxHash.toLowerCase()),
      ),
    )
    .orderBy(asc(transferTraces.sourceLogIndex));
}

export async function findTraceByNonce(
  db: Tx,
  sourceDomain: number,
  nonce: string,
): Promise<TraceRow | undefined> {
  const [row] = await db
    .select()
    .from(transferTraces)
    .where(
      and(
        eq(transferTraces.sourceDomain, sourceDomain),
        eq(transferTraces.messageNonce, nonce.toLowerCase()),
      ),
    );
  return row;
}

export async function updateTrace(
  db: Tx,
  id: string,
  patch: Partial<Pick<TraceRow, "status" | "statusReason" | "messageNonce">>,
): Promise<void> {
  await db
    .update(transferTraces)
    .set({
      ...patch,
      ...(patch.messageNonce ? { messageNonce: patch.messageNonce.toLowerCase() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(transferTraces.id, id));
}

// ---- observed events ------------------------------------------------------------------------

/** Inserts chain events, ignoring ones already stored. Returns the number of new rows. */
export async function insertEvents(
  db: Tx,
  events: readonly ChainEvent[],
  traceId: string | null,
): Promise<number> {
  if (events.length === 0) return 0;
  const rows = await db
    .insert(observedEvents)
    .values(
      events.map((e) => ({
        traceId,
        chainId: e.chainId,
        domain: e.domain,
        blockNumber: e.blockNumber,
        blockHash: e.blockHash.toLowerCase(),
        txHash: e.txHash.toLowerCase(),
        logIndex: e.logIndex,
        eventType: e.kind,
        nonce: e.kind === "message_received" ? e.nonce.toLowerCase() : null,
        rawPayload: toJsonSafe({ txHash: e.txHash, logIndex: e.logIndex, blockHash: e.blockHash }),
        decoded: toJsonSafe(e),
      })),
    )
    // Re-observing a log after a reorg (same tx re-included, possibly in another block) revives
    // the row; an identical duplicate is a no-op.
    .onConflictDoUpdate({
      target: [observedEvents.chainId, observedEvents.txHash, observedEvents.logIndex],
      set: {
        removed: false,
        blockNumber: sql`excluded.block_number`,
        blockHash: sql`excluded.block_hash`,
        decoded: sql`excluded.decoded`,
      },
      setWhere: sql`${observedEvents.removed} or ${observedEvents.blockHash} <> excluded.block_hash`,
    })
    .returning({ id: observedEvents.id });
  return rows.length;
}

/** Attaches uncorrelated events from one destination tx to a trace. */
export async function linkTxEvents(
  db: Tx,
  traceId: string,
  chainId: number,
  txHash: string,
): Promise<void> {
  await db
    .update(observedEvents)
    .set({ traceId })
    .where(
      and(
        eq(observedEvents.chainId, chainId),
        eq(observedEvents.txHash, txHash.toLowerCase()),
        isNull(observedEvents.traceId),
      ),
    );
}

export async function getTraceEvents(db: Tx, traceId: string): Promise<ObservedEventRow[]> {
  return db
    .select()
    .from(observedEvents)
    .where(eq(observedEvents.traceId, traceId))
    .orderBy(
      asc(observedEvents.chainId),
      asc(observedEvents.blockNumber),
      asc(observedEvents.logIndex),
    );
}

export async function findReceivedEventByNonce(
  db: Tx,
  chainId: number,
  nonce: string,
): Promise<ObservedEventRow | undefined> {
  const [row] = await db
    .select()
    .from(observedEvents)
    .where(
      and(
        eq(observedEvents.chainId, chainId),
        eq(observedEvents.nonce, nonce.toLowerCase()),
        eq(observedEvents.removed, false),
      ),
    );
  return row;
}

// ---- attestations ---------------------------------------------------------------------------

export function responseHash(raw: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(toJsonSafe(raw)))
    .digest("hex");
}

/** Stores an Iris observation; an identical response already stored for the trace is skipped. */
export async function insertAttestation(
  db: Tx,
  traceId: string,
  observation: AttestationObserved,
  rawResponse: unknown,
): Promise<boolean> {
  const rows = await db
    .insert(attestationObservations)
    .values({
      traceId,
      status: observation.status,
      nonce: observation.nonce?.toLowerCase() ?? null,
      delayReason: observation.delayReason,
      responseHash: responseHash(rawResponse),
      rawResponse: toJsonSafe(rawResponse),
      observedAt: observation.observedAt,
    })
    .onConflictDoNothing()
    .returning({ id: attestationObservations.id });
  return rows.length > 0;
}

// ---- cursors --------------------------------------------------------------------------------

export async function getCursor(db: Tx, stream: string): Promise<bigint | null> {
  const [row] = await db.select().from(chainCursors).where(eq(chainCursors.stream, stream));
  return row?.nextBlock ?? null;
}

/**
 * Records processed block hashes and moves the cursor. Call inside the same transaction as the
 * event inserts for the range, so a crash can never advance the cursor past unsaved events.
 */
export async function commitRange(
  db: Tx,
  stream: string,
  chainId: number,
  nextBlock: bigint,
  blocks: ReadonlyArray<{ number: bigint; hash: string }>,
  keepBlocks = 256n,
): Promise<void> {
  if (blocks.length > 0) {
    await db
      .insert(chainBlocks)
      .values(
        blocks.map((b) => ({ stream, blockNumber: b.number, blockHash: b.hash.toLowerCase() })),
      )
      .onConflictDoUpdate({
        target: [chainBlocks.stream, chainBlocks.blockNumber],
        set: { blockHash: sql`excluded.block_hash` },
      });
  }
  await db
    .insert(chainCursors)
    .values({ stream, chainId, nextBlock })
    .onConflictDoUpdate({ target: chainCursors.stream, set: { nextBlock, updatedAt: new Date() } });
  await db
    .delete(chainBlocks)
    .where(
      and(eq(chainBlocks.stream, stream), lt(chainBlocks.blockNumber, nextBlock - keepBlocks)),
    );
}

export async function getStoredBlockHash(
  db: Tx,
  stream: string,
  blockNumber: bigint,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(chainBlocks)
    .where(and(eq(chainBlocks.stream, stream), eq(chainBlocks.blockNumber, blockNumber)));
  return row?.blockHash ?? null;
}

/**
 * Reorg rewind: marks events at or above `fromBlock` as removed (kept as evidence), drops stored
 * block hashes, and moves the cursor back so the range is re-read.
 */
export async function rewindStream(
  db: Tx,
  stream: string,
  chainId: number,
  fromBlock: bigint,
): Promise<void> {
  await db
    .update(observedEvents)
    .set({ removed: true })
    .where(and(eq(observedEvents.chainId, chainId), gte(observedEvents.blockNumber, fromBlock)));
  await db
    .delete(chainBlocks)
    .where(and(eq(chainBlocks.stream, stream), gte(chainBlocks.blockNumber, fromBlock)));
  await db
    .update(chainCursors)
    .set({ nextBlock: fromBlock, updatedAt: new Date() })
    .where(eq(chainCursors.stream, stream));
}

export async function listRecentTraces(db: Tx, limit = 20): Promise<TraceRow[]> {
  return db
    .select()
    .from(transferTraces)
    .orderBy(desc(transferTraces.firstSeenAt), desc(transferTraces.id))
    .limit(Math.min(Math.max(limit, 1), 100));
}
