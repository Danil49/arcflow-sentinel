import { asc, eq } from "drizzle-orm";
import {
  attestationObservations,
  getInvariantResults,
  getTrace,
  getTraceEvents,
  listEvidenceBundles,
  listRecentTraces,
} from "@sentinel/db";
import { toDto } from "./api/traces.js";
import { traceId } from "./api/schemas.js";
import type { ApiContext } from "./context.js";

export type TraceView = NonNullable<Awaited<ReturnType<typeof loadTraceView>>>;

/** Everything the trace page renders, read straight from the database (no chain calls). */
export async function loadTraceView(ctx: ApiContext, rawId: string) {
  const id = traceId.safeParse(rawId);
  if (!id.success) return null;
  const row = await getTrace(ctx.db, id.data);
  if (!row) return null;
  const [events, invariants, attestations, bundles] = await Promise.all([
    getTraceEvents(ctx.db, row.id),
    getInvariantResults(ctx.db, row.id),
    ctx.db
      .select()
      .from(attestationObservations)
      .where(eq(attestationObservations.traceId, row.id))
      .orderBy(asc(attestationObservations.observedAt)),
    listEvidenceBundles(ctx.db, row.id),
  ]);
  return {
    trace: toDto(ctx, row),
    events: events.map((e) => ({
      chainId: e.chainId,
      domain: e.domain,
      blockNumber: e.blockNumber.toString(),
      txHash: e.txHash,
      logIndex: e.logIndex,
      eventType: e.eventType as "burn" | "message_sent" | "message_received" | "mint",
      removed: e.removed,
      observedAt: e.observedAt,
      explorerUrl: explorerFor(ctx, e.domain, e.txHash),
    })),
    attestations: attestations.map((a) => ({
      status: a.status,
      delayReason: a.delayReason,
      observedAt: a.observedAt,
    })),
    invariants: invariants.map((i) => ({
      ruleId: i.ruleId,
      result: i.result,
      explanation: i.explanation,
      evaluatedAt: i.evaluatedAt,
    })),
    latestEvidence: bundles[0]
      ? {
          keccak256: bundles[0].keccak256,
          sha256: bundles[0].sha256,
          anchorTxHash: bundles[0].anchorTxHash,
        }
      : null,
    signingEnabled: ctx.signer !== null,
  };
}

function explorerFor(ctx: ApiContext, domain: number, txHash: string): string | null {
  const side = Object.values(ctx.sides).find((s) => s.config.domain === domain);
  return side ? side.config.explorerTxUrl(txHash) : null;
}

export async function loadRecent(ctx: ApiContext, limit = 12) {
  return (await listRecentTraces(ctx.db, limit)).map((t) => toDto(ctx, t));
}
