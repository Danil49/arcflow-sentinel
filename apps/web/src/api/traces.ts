import { asc, eq } from "drizzle-orm";
import type { Hex } from "viem";
import type { RouteChain } from "@sentinel/chains";
import {
  attestationObservations,
  findTracesBySourceTx,
  getInvariantResults,
  getTrace,
  getTraceEvents,
  type TraceRow,
} from "@sentinel/db";
import { confirmTrace, createTraces } from "@sentinel/worker";
import type { ApiContext } from "../context.js";
import { HttpError, isAuthorized, json, parse, parseBody, requireAuth } from "../http.js";
import {
  confirmBody,
  createTraceBody,
  traceId,
  traceLookupQuery,
  type TraceDto,
} from "./schemas.js";

function chainOfDomain(ctx: ApiContext, domain: number): RouteChain {
  const key = (Object.keys(ctx.sides) as RouteChain[]).find(
    (k) => ctx.sides[k].config.domain === domain,
  );
  if (!key) throw new Error(`domain ${domain} is not on the configured route`);
  return key;
}

export function toDto(ctx: ApiContext, t: TraceRow): TraceDto {
  const source = chainOfDomain(ctx, t.sourceDomain);
  const destination = chainOfDomain(ctx, t.destinationDomain);
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    id: t.id,
    route: {
      sourceChain: source,
      sourceDomain: t.sourceDomain,
      destinationChain: destination,
      destinationDomain: t.destinationDomain,
    },
    sourceTxHash: t.sourceTxHash,
    sourceLogIndex: t.sourceLogIndex,
    sourceBlockNumber: t.sourceBlockNumber.toString(),
    sourceBlockTime: iso(t.sourceBlockTime),
    nonce: t.messageNonce,
    sender: t.sender,
    recipient: t.recipient,
    amountAtomic: t.amountAtomic.toString(),
    status: t.status as TraceDto["status"],
    progress: t.progress as TraceDto["progress"],
    reason: t.reason as TraceDto["reason"],
    statusReason: t.statusReason,
    destinationTxHash: t.destinationTxHash,
    stageDeadlineAt: iso(t.stageDeadlineAt),
    requireAppConfirmation: t.requireAppConfirmation,
    applicationConfirmedAt: iso(t.applicationConfirmedAt),
    applicationReference: t.applicationReference,
    explorer: {
      source: ctx.sides[source].config.explorerTxUrl(t.sourceTxHash),
      destination: t.destinationTxHash
        ? ctx.sides[destination].config.explorerTxUrl(t.destinationTxHash)
        : null,
    },
    firstSeenAt: t.firstSeenAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

async function loadTrace(ctx: ApiContext, rawId: string): Promise<TraceRow> {
  const id = traceId.safeParse(rawId);
  const trace = id.success ? await getTrace(ctx.db, id.data) : undefined;
  if (!trace) throw new HttpError(404, "Trace not found");
  return trace;
}

/** POST /api/traces — idempotent: 201 when created, 200 with the existing trace(s) otherwise. */
export async function postTraces(ctx: ApiContext, req: Request): Promise<Response> {
  const body = await parseBody(req, createTraceBody);
  if (body.requireAppConfirmation && !isAuthorized(ctx, req)) {
    // Otherwise anyone could make someone else's trace wait for a confirmation that never comes.
    throw new HttpError(401, "Unauthorized", "requireAppConfirmation needs an API key");
  }
  const existing = await findTracesBySourceTx(
    ctx.db,
    ctx.sides[body.sourceChain].config.chain.id,
    body.sourceTxHash,
  );
  if (
    existing.length > 0 &&
    !(body.requireAppConfirmation && existing.some((t) => !t.requireAppConfirmation))
  ) {
    return json({ traces: existing.map((t) => toDto(ctx, t)) }, 200);
  }
  const { traces, created } = await createTraces(
    ctx.pipeline(body.sourceChain),
    body.sourceTxHash as Hex,
    {
      ...(body.requireAppConfirmation ? { requireAppConfirmation: true } : {}),
    },
  );
  return json({ traces: traces.map((t) => toDto(ctx, t)) }, created ? 201 : 200);
}

/** GET /api/traces?sourceTxHash=…&sourceChain=… */
export async function getTracesBySource(ctx: ApiContext, req: Request): Promise<Response> {
  const q = parse(traceLookupQuery, Object.fromEntries(new URL(req.url).searchParams));
  const traces = await findTracesBySourceTx(
    ctx.db,
    ctx.sides[q.sourceChain].config.chain.id,
    q.sourceTxHash,
  );
  if (traces.length === 0) throw new HttpError(404, "Trace not found");
  return json({ traces: traces.map((t) => toDto(ctx, t)) });
}

export async function getTraceById(ctx: ApiContext, id: string): Promise<Response> {
  return json(toDto(ctx, await loadTrace(ctx, id)));
}

export async function getEvents(ctx: ApiContext, id: string): Promise<Response> {
  const trace = await loadTrace(ctx, id);
  const events = await getTraceEvents(ctx.db, trace.id);
  const iris = await ctx.db
    .select()
    .from(attestationObservations)
    .where(eq(attestationObservations.traceId, trace.id))
    .orderBy(asc(attestationObservations.observedAt));
  return json({
    events: events.map((e) => ({
      chainId: e.chainId,
      domain: e.domain,
      blockNumber: e.blockNumber.toString(),
      blockHash: e.blockHash,
      txHash: e.txHash,
      logIndex: e.logIndex,
      eventType: e.eventType,
      removed: e.removed,
      observedAt: e.observedAt.toISOString(),
      decoded: e.decoded,
    })),
    attestations: iris.map((a) => ({
      status: a.status,
      nonce: a.nonce,
      delayReason: a.delayReason,
      responseHash: a.responseHash,
      observedAt: a.observedAt.toISOString(),
    })),
  });
}

export async function getInvariants(ctx: ApiContext, id: string): Promise<Response> {
  const trace = await loadTrace(ctx, id);
  const rows = await getInvariantResults(ctx.db, trace.id);
  return json({
    invariants: rows.map((r) => ({
      ruleId: r.ruleId,
      result: r.result,
      explanation: r.explanation,
      evidenceRefs: r.evidenceRefs,
      evaluatedAt: r.evaluatedAt.toISOString(),
    })),
  });
}

/** POST /api/traces/{id}/confirm — authenticated; idempotent. */
export async function postConfirm(ctx: ApiContext, req: Request, id: string): Promise<Response> {
  requireAuth(ctx, req);
  const trace = await loadTrace(ctx, id);
  const text = await req.text();
  const body = text ? parse(confirmBody, safeJson(text)) : {};
  if (!trace.requireAppConfirmation) {
    throw new HttpError(
      409,
      "Confirmation not required",
      "this trace was not created with requireAppConfirmation",
    );
  }
  const source = chainOfDomain(ctx, trace.sourceDomain);
  await confirmTrace({ ...ctx.pipeline(source), now: ctx.now }, trace.id, body.reference ?? null);
  return json(toDto(ctx, (await getTrace(ctx.db, trace.id))!));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
