import { asc, eq } from "drizzle-orm";
import {
  EVIDENCE_SCHEMA,
  sealEvidence,
  type EvidenceBundle,
  type EvidencePayload,
  type EvidenceSigner,
} from "@sentinel/evidence";
import {
  attestationObservations,
  getInvariantResults,
  getTrace,
  observedEvents,
  upsertEvidenceBundle,
  type Db,
  type EvidenceBundleRow,
  type TraceRow,
} from "@sentinel/db";

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Assembles the evidence payload from stored observations and the persisted verdict. */
export async function buildEvidencePayload(
  db: Db,
  trace: TraceRow,
  network: EvidencePayload["network"],
): Promise<EvidencePayload> {
  // Removed (reorged) events are included on purpose: they are part of the record.
  const events = await db
    .select()
    .from(observedEvents)
    .where(eq(observedEvents.traceId, trace.id))
    .orderBy(asc(observedEvents.id));
  const iris = await db
    .select()
    .from(attestationObservations)
    .where(eq(attestationObservations.traceId, trace.id))
    .orderBy(asc(attestationObservations.id));
  const invariants = await getInvariantResults(db, trace.id);

  return {
    schema: EVIDENCE_SCHEMA,
    network,
    trace: {
      id: trace.id,
      sourceDomain: trace.sourceDomain,
      destinationDomain: trace.destinationDomain,
      sourceChainId: trace.sourceChainId,
      sourceTxHash: trace.sourceTxHash,
      sourceLogIndex: trace.sourceLogIndex,
      sourceBlockNumber: trace.sourceBlockNumber.toString(),
      sourceBlockTime: iso(trace.sourceBlockTime),
      nonce: trace.messageNonce,
      sender: trace.sender,
      recipient: trace.recipient,
      amountAtomic: trace.amountAtomic.toString(),
      destinationTxHash: trace.destinationTxHash,
      requireAppConfirmation: trace.requireAppConfirmation,
      applicationConfirmedAt: iso(trace.applicationConfirmedAt),
      applicationReference: trace.applicationReference,
    },
    verdict: {
      status: trace.status,
      progress: trace.progress,
      reason: trace.reason,
      statusReason: trace.statusReason,
      stageDeadlineAt: iso(trace.stageDeadlineAt),
    },
    invariants: invariants.map((i) => ({
      ruleId: i.ruleId,
      result: i.result,
      explanation: i.explanation,
      evidenceRefs: i.evidenceRefs as string[],
    })),
    observations: {
      chainEvents: events.map((e) => ({
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
    },
  };
}

/**
 * Seals the trace's current evidence and stores it. Unchanged evidence yields the same hashes,
 * so repeated calls return the same stored bundle.
 */
export async function sealTraceEvidence(
  db: Db,
  traceId: string,
  signer: EvidenceSigner,
  network: EvidencePayload["network"],
): Promise<{ bundle: EvidenceBundle; row: EvidenceBundleRow } | null> {
  const trace = await getTrace(db, traceId);
  if (!trace) return null;
  const bundle = sealEvidence(await buildEvidencePayload(db, trace, network), signer);
  const row = await upsertEvidenceBundle(db, {
    traceId,
    schemaVersion: bundle.payload.schema,
    sha256: bundle.hashes.sha256,
    keccak256: bundle.hashes.keccak256,
    keyId: bundle.signature.keyId,
    status: bundle.payload.verdict.status,
    bundle,
  });
  return { bundle, row };
}
